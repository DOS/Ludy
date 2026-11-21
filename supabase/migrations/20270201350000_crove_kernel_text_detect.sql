-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #4001, Slice 1): code-only detector for unknown sensitive values in free text and span-verified redaction.
-- Idempotent; applied files stay untouched.
--
-- crove_kernel.text_detect(p_text text)
--   Returns (kind text, start_pos integer, end_pos integer, match_text text) in ascending start_pos order, non-overlapping.
--   - start_pos is 1-based Unicode character index; end_pos is 1-based exclusive end (pg_catalog.substr(p_text, start_pos, end_pos - start_pos) = match_text).
--   - kind is one of: 'email', 'phone', 'national_id', 'tax_code', 'bank_account'.
--   - Reuses the inline space set, non-ASCII Latin letters, email boundaries, +84/0/84 phone rules, and 8-20 digit bounds of
--     crove_kernel.text_mention_pattern (20261122040000), while rejecting near-misses (prices, dot-thousands, years, short counts,
--     dates, percentages, timestamps, IPv4, UUIDs, URLs, meeting numbers).
--
-- crove_kernel.text_redact_spans(p_text text, p_starts integer[], p_kinds text[], p_marks text[])
--   Re-runs crove_kernel.text_detect(p_text) and replaces only detected spans whose (start_pos, kind) matches a requested item,
--   using the literal mark text (never trusting client offsets or lengths directly).
--
-- Both are pure IMMUTABLE PARALLEL SAFE SECURITY INVOKER functions with pinned search_path = pg_catalog, pg_temp,
-- revoked from PUBLIC and granted to crove_tenant (matching text_mentions / text_redact).
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.text_detect(p_text text)
RETURNS TABLE(kind text, start_pos integer, end_pos integer, match_text text)
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  -- Same inline spaces and non-ASCII Latin letter ranges as crove_kernel.text_mention_pattern (20261122040000).
  v_inline constant text := ' ' || pg_catalog.chr(160) || pg_catalog.chr(8199) || pg_catalog.chr(8239) || pg_catalog.chr(65279);
  v_letters constant text := pg_catalog.chr(192) || '-' || pg_catalog.chr(214) || pg_catalog.chr(216) || '-' || pg_catalog.chr(246)
    || pg_catalog.chr(248) || '-' || pg_catalog.chr(591) || pg_catalog.chr(768) || '-' || pg_catalog.chr(879)
    || pg_catalog.chr(7680) || '-' || pg_catalog.chr(7935);
  v_sep constant text := '[' || v_inline || '.-]';
  -- Disjoint local-part character sets so email scanning is linear without backtracking.
  v_local_edge constant text := 'a-z0-9_+' || v_letters;
  v_local_inner constant text := '!#$%&''*/=?^`{|}~-';
  v_local_seg constant text := '[' || v_local_edge || ']+(?:[' || v_local_inner || ']+[' || v_local_edge || ']+)*';
  v_local_part constant text := v_local_seg || '(?:\.' || v_local_seg || ')*';
  v_dom_char constant text := 'a-z0-9' || v_letters;
  v_dom_label constant text := '[' || v_dom_char || ']+(?:-+[' || v_dom_char || ']+)*';
  v_tld constant text := '(?:xn--[a-z0-9]+|[a-z' || v_letters || ']{2,63})';
  v_email_pat constant text := v_local_part || '@(?:' || v_dom_label || '\.)+' || v_tld;
  -- Inline digit spans (newlines always part adjacent numbers; optional area/country code parens or + prefix).
  v_num_prefix constant text := '(?:\(\+?[0-9]{1,4}\)(?:' || v_sep || '?\(0\))?' || v_sep || '?|\+[0-9]{1,3}(?:' || v_sep || '?\([0-9]{1,4}\))?' || v_sep || '?|(?:00)?84' || v_sep || '?\(0\)' || v_sep || '?)';
  v_num_pat constant text := '(?:' || v_num_prefix || '[0-9](?:' || v_sep || '?[0-9]){4,}|[0-9](?:' || v_sep || '?[0-9]){7,})';
  v_has_at boolean;
  v_has_digit boolean;
  v_pat text;
  v_pos integer := 1;
  v_len integer;
  v_start integer;
  v_end integer;
  v_match text;
  v_prev1 text;
  v_prev2 text;
  v_next1 text;
  v_next2 text;
  v_after text;
  v_line_before text;
  v_line_after text;
  v_url_before text;
  v_token text;
  v_at_pos integer;
  v_digits text;
  v_vn_digits text;
  v_digit_len integer;
  v_has_plus boolean;
  v_ctx_before text;
  v_ctx_after text;
  v_tax_hint boolean;
  v_id_hint boolean;
  v_bank_hint boolean;
  v_phone_hint boolean;
  v_mst_sum integer;
  v_mst_check integer;
  v_mst_valid boolean;
  v_kind text;
BEGIN
  IF p_text IS NULL OR p_text = '' THEN
    RETURN;
  END IF;

  v_has_at := pg_catalog.strpos(p_text, '@') > 0;
  v_has_digit := p_text ~ '[0-9]';
  IF NOT v_has_at AND NOT v_has_digit THEN
    RETURN;
  END IF;

  IF v_has_at AND v_has_digit THEN
    v_pat := '(?:' || v_email_pat || '|' || v_num_pat || ')';
  ELSIF v_has_at THEN
    v_pat := v_email_pat;
  ELSE
    v_pat := v_num_pat;
  END IF;

  v_len := pg_catalog.char_length(p_text);
  WHILE v_pos <= v_len LOOP
    v_start := pg_catalog.regexp_instr(p_text, v_pat, v_pos, 1, 0, 'i');
    EXIT WHEN v_start = 0;
    v_end := pg_catalog.regexp_instr(p_text, v_pat, v_start, 1, 1, 'i');
    IF v_end <= v_start THEN
      v_pos := v_start + 1;
      CONTINUE;
    END IF;

    v_match := pg_catalog.substr(p_text, v_start, v_end - v_start);
    v_pos := v_end;

    v_prev1 := CASE WHEN v_start > 1 THEN pg_catalog.substr(p_text, v_start - 1, 1) ELSE '' END;
    v_prev2 := CASE WHEN v_start > 2 THEN pg_catalog.substr(p_text, v_start - 2, 1) ELSE '' END;
    v_next1 := CASE WHEN v_end <= v_len THEN pg_catalog.substr(p_text, v_end, 1) ELSE '' END;
    v_next2 := CASE WHEN v_end < v_len THEN pg_catalog.substr(p_text, v_end + 1, 1) ELSE '' END;
    v_after := pg_catalog.substr(p_text, v_end, 2);

    v_at_pos := pg_catalog.strpos(v_match, '@');
    IF v_at_pos > 0 THEN
      -- Whole-address boundary rules matching crove_kernel.text_mention_pattern.
      IF pg_catalog.char_length(v_match) > 320 OR v_at_pos - 1 > 64 OR pg_catalog.char_length(v_match) - v_at_pos > 255 THEN
        CONTINUE;
      END IF;
      IF v_prev1 <> '' AND (
        v_prev1 ~* ('[' || v_local_edge || ']')
        OR (v_prev1 ~ ('[' || '.' || v_local_inner || ']') AND v_prev2 <> '' AND v_prev2 ~* ('[' || v_local_edge || '.' || v_local_inner || ']'))
      ) THEN
        CONTINUE;
      END IF;
      IF v_after <> '' AND (
        v_next1 ~* ('^[a-z0-9_' || v_letters || '-]$')
        OR v_after ~* ('^\.[a-z0-9_' || v_letters || ']')
      ) THEN
        CONTINUE;
      END IF;

      kind := 'email';
      start_pos := v_start;
      end_pos := v_end;
      match_text := v_match;
      RETURN NEXT;
      CONTINUE;
    END IF;

    -- Digit run candidate: enforce boundary checks and extract raw digits.
    IF v_prev1 <> '' AND v_prev1 ~* ('[a-z0-9_' || v_letters || ']') THEN
      CONTINUE;
    END IF;
    IF v_next1 <> '' AND (
      v_next1 ~* ('[a-z0-9_' || v_letters || '@]')
      OR (v_next1 ~ ('[' || v_inline || '.-]') AND v_next2 ~ '^[0-9]$')
    ) THEN
      CONTINUE;
    END IF;

    v_digits := pg_catalog.regexp_replace(v_match, '[^0-9]', '', 'g');
    IF pg_catalog.length(v_digits) NOT BETWEEN 8 AND 20 THEN
      CONTINUE;
    END IF;

    v_has_plus := v_match ~ '^\(?\+';
    v_vn_digits := CASE
      WHEN (v_has_plus OR v_digits ~ '^0084' OR v_match ~ ('^84[' || v_inline || '.-]*\(0'))
           AND v_digits ~ '^(?:00)?840(?:[35789][0-9]{8}|2[0-9]{9}|1[2689][0-9]{8})$'
        THEN pg_catalog.regexp_replace(v_digits, '^(00)?840', '\184')
      ELSE v_digits
    END;
    v_digit_len := pg_catalog.length(v_vn_digits);
    IF v_digit_len < 8 THEN
      CONTINUE;
    END IF;

    -- Line-scoped context before and after the candidate (never crossing line breaks).
    v_url_before := pg_catalog.regexp_replace(
      pg_catalog.substr(p_text, GREATEST(1, v_start - 256), v_start - GREATEST(1, v_start - 256)),
      '^.*[\r\n]',
      ''
    );
    v_line_before := pg_catalog.right(v_url_before, 64);
    v_line_after := pg_catalog.regexp_replace(pg_catalog.substr(p_text, v_end, 40), '[\r\n].*$', '');

    -- Reject numbers inside http(s) URLs (e.g. Zoom /j/1234567890) or UUID tokens.
    IF v_url_before ~* 'https?://[^[:space:]]+$' THEN
      CONTINUE;
    END IF;
    v_token := pg_catalog.regexp_replace(v_url_before, '^.*[^a-zA-Z0-9_-]', '')
      || v_match
      || pg_catalog.regexp_replace(v_line_after, '[^a-zA-Z0-9_-].*$', '');
    IF v_token ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      CONTINUE;
    END IF;

    v_ctx_before := pg_catalog.normalize(pg_catalog.lower(v_line_before), 'NFC');
    v_ctx_after := pg_catalog.normalize(pg_catalog.lower(v_line_after), 'NFC');

    -- Reject percentages (e.g. 12345678%, 100000 %).
    IF v_ctx_after ~ ('^[' || v_inline || ']*%') THEN
      CONTINUE;
    END IF;

    -- Reject negative non-zero-prefixed numbers (e.g. -123456789).
    IF NOT v_has_plus AND pg_catalog.left(v_digits, 1) <> '0' AND v_prev1 = '-'
       AND (v_prev2 = '' OR v_prev2 !~* ('[a-z0-9_' || v_letters || ']')) THEN
      CONTINUE;
    END IF;

    -- Reject meeting / room numbers when explicitly labelled (e.g. Zoom ID 842 1234 5678, cuộc họp số 912 3456 7890).
    IF NOT v_has_plus AND v_ctx_before ~ ('(?:^|[^a-z0-9' || v_letters || '])(?:meeting|zoom|cuộc họp|cuoc hop|buổi họp|buoi hop|phòng họp|phong hop|mã họp|ma hop|mã cuộc họp|ma cuoc hop|id cuộc họp|id cuoc hop|meeting id|meeting no|meeting number)[' || v_inline || ':#.-]*(?:số|so|id|no|#)?[' || v_inline || ':#.-]*$') THEN
      CONTINUE;
    END IF;

    v_tax_hint := v_ctx_before ~ ('(?:^|[^a-z0-9' || v_letters || '])(?:mst|mã số thuế|ma so thue|tax[' || v_inline || '_-]*code|tax[' || v_inline || '_-]*id|tin)[' || v_inline || ':#.-]*(?:số|so)?[' || v_inline || ':#.-]*$');
    v_id_hint := v_ctx_before ~ ('(?:^|[^a-z0-9' || v_letters || '])(?:cccd|cmnd|căn cước|can cuoc|chứng minh|chung minh|national[' || v_inline || '_-]*id|id[' || v_inline || '_-]*card|số định danh|so dinh danh)(?:[' || v_inline || ':#.-]+(?:công dân|cong dan|nhân dân|nhan dan|số|so|cũ|cu|mới|moi)){0,2}[' || v_inline || ':#.-]*$');
    v_bank_hint := v_ctx_before ~ ('(?:^|[^a-z0-9' || v_letters || '])(?:stk|số tài khoản|so tai khoan|tài khoản|tai khoan|tk|số thẻ|so the|thẻ|visa|mastercard|napas|atm|iban|bank[' || v_inline || '_-]*account|account[' || v_inline || '_-]*(?:no|number|#)?|card[' || v_inline || '_-]*(?:no|number|#)?|acct)(?:[' || v_inline || ':#.-]+(?:ngân hàng|ngan hang|số|so|acb|vcb|vietcombank|tcb|techcombank|bidv|ctg|vietinbank|mb|mbbank|vpb|vpbank|tpb|tpbank|stb|sacombank|agribank|vib|hdbank|ocb|shb|msb|eximbank|seabank|vnd|usd)){0,2}[' || v_inline || ':#.-]*$');
    v_phone_hint := v_ctx_before ~ ('(?:^|[^a-z0-9' || v_letters || '])(?:sđt|sdt|điện thoại|dien thoai|số điện thoại|so dien thoai|zalo|hotline|tel|phone|mobile|call|gọi|goi|liên hệ|lien he|alô|alo)[' || v_inline || ':#.-]*(?:số|so)?[' || v_inline || ':#.-]*$');

    -- Reject currency-tagged amounts (e.g. 100.000.000 đ, +100.000.000 đ, 50000000 VND, +50000000 VND, USD +12345678, $123456789).
    IF (NOT v_has_plus OR NOT v_phone_hint) AND (
      v_prev1 IN ('$', '€', '£', '¥', '₫')
      OR (NOT v_bank_hint AND NOT v_tax_hint AND v_ctx_before ~ ('(?:^|[^a-z0-9' || v_letters || '])(?:usd|vnd|vnđ|eur|jpy|gbp|krw|aud|sgd|cny|rmb)[' || v_inline || ':]*$'))
      OR (pg_catalog.left(v_digits, 1) <> '0' AND v_ctx_after ~ ('^[' || v_inline || ']*(?:₫|\$|€|£|¥|(?:vnd|vnđ|đồng|đ|usd|eur|jpy|gbp|krw|aud|sgd|cny|rmb|triệu|tỷ|tỉ|nghìn|ngàn|xu)(?![a-z0-9_' || v_letters || ']))'))
      OR (pg_catalog.left(v_digits, 1) = '0' AND v_ctx_after ~ ('^[' || v_inline || ']*(?:₫|\$|€|£|¥|(?:vnd|vnđ|đồng|đ|usd|eur|jpy|gbp|krw|aud|sgd|cny|rmb)(?![a-z0-9_' || v_letters || ']))'))
    ) THEN
      CONTINUE;
    END IF;

    -- Reject dot-grouped thousands (+100.000.000, 100.000.000), decimal floats (+3.14159265, 1234567.89), and IPv4 dotted quads (192.168.1.100).
    IF NOT (v_phone_hint OR v_bank_hint OR v_id_hint OR v_tax_hint) AND (
      (
        pg_catalog.regexp_replace(v_match, '^\+', '') ~ '^[1-9][0-9]{0,2}(?:\.[0-9]{3}){2,}$'
        AND NOT (v_has_plus AND v_vn_digits ~ '^84(?:[35789][0-9]{8}|2[0-9]{9})$' AND v_match !~ '\.000\.000$')
      )
      OR pg_catalog.regexp_replace(v_match, '^\+', '') ~ '^[0-9]{1,2}\.[0-9]{5,}$'
      OR pg_catalog.regexp_replace(v_match, '^\+', '') ~ '^[0-9]{6,}\.[0-9]{1,2}$'
      OR (
        pg_catalog.regexp_replace(v_match, '^\+', '') ~ '^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$'
        AND NOT (v_has_plus AND v_vn_digits ~ '^84(?:[35789][0-9]{8}|2[0-9]{9})$')
      )
    ) THEN
      CONTINUE;
    END IF;

    -- Reject dates, year ranges, date+hour timestamps (01 02 2025 12, 2026-11-21 13), and compact timestamps (20261121132157).
    IF NOT v_has_plus AND (
      v_match ~ ('^(?:0?[1-9]|[12][0-9]|3[01])[' || v_inline || '.-](?:0?[1-9]|1[0-2])[' || v_inline || '.-](?:19|20)[0-9]{2}$')
      OR v_match ~ ('^(?:0?[1-9]|1[0-2])[' || v_inline || '.-](?:0?[1-9]|[12][0-9]|3[01])[' || v_inline || '.-](?:19|20)[0-9]{2}$')
      OR v_match ~ ('^(?:19|20)[0-9]{2}[' || v_inline || '.-](?:0?[1-9]|1[0-2])[' || v_inline || '.-](?:0?[1-9]|[12][0-9]|3[01])$')
      OR v_match ~ ('^(?:19|20)[0-9]{2}[' || v_inline || '.-](?:19|20)[0-9]{2}$')
      OR v_match ~ ('^(?:0?[1-9]|[12][0-9]|3[01])[' || v_inline || '.-](?:0?[1-9]|1[0-2])[' || v_inline || '.-](?:19|20)[0-9]{2}[' || v_inline || '.-](?:[01]?[0-9]|2[0-3])$')
      OR v_match ~ ('^(?:0?[1-9]|1[0-2])[' || v_inline || '.-](?:0?[1-9]|[12][0-9]|3[01])[' || v_inline || '.-](?:19|20)[0-9]{2}[' || v_inline || '.-](?:[01]?[0-9]|2[0-3])$')
      OR v_match ~ ('^(?:19|20)[0-9]{2}[' || v_inline || '.-](?:0?[1-9]|1[0-2])[' || v_inline || '.-](?:0?[1-9]|[12][0-9]|3[01])[' || v_inline || '.-](?:[01]?[0-9]|2[0-3])$')
      OR v_digits ~ '^(?:19|20)[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])$'
      OR v_digits ~ '^(?:0[1-9]|[12][0-9]|3[01])(?:0[1-9]|1[0-2])(?:19|20)[0-9]{2}$'
    ) THEN
      CONTINUE;
    END IF;

    -- Reject compact 14-digit YYYYMMDDHHmmSS timestamps unless explicitly labelled as bank/ID/tax.
    IF NOT v_has_plus AND NOT (v_bank_hint OR v_id_hint OR v_tax_hint)
       AND v_digit_len = 14 AND v_vn_digits ~ '^(?:19|20)[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])(?:[01][0-9]|2[0-3])[0-5][0-9][0-5][0-9]$' THEN
      CONTINUE;
    END IF;

    -- Reject round non-zero-prefixed amounts (e.g. 100000000, +100000000, 100 000 000) unless explicitly labelled or a valid +84 phone.
    IF NOT (v_phone_hint OR v_bank_hint OR v_id_hint OR v_tax_hint)
       AND NOT (v_has_plus AND v_vn_digits ~ '^84(?:[35789][0-9]{8}|2[0-9]{9})$' AND v_vn_digits !~ '000000$')
       AND pg_catalog.left(v_vn_digits, 1) <> '0'
       AND (
         v_vn_digits ~ '00000$'
         OR (pg_catalog.regexp_replace(v_match, '^\+', '') ~ ('^[1-9][0-9]{0,2}(?:[' || v_inline || '][0-9]{3}){2,}$') AND v_vn_digits ~ '0000$')
       ) THEN
      CONTINUE;
    END IF;

    v_kind := NULL;

    -- 1. Phone numbers: VN mobile/landline (+84/0084/84/0) and explicit international or NANP formats.
    IF v_has_plus THEN
      IF v_vn_digits ~ '^84(?:[35789][0-9]{8}|2[0-9]{9}|1[2689][0-9]{8})$' THEN
        v_kind := 'phone';
      ELSIF v_vn_digits !~ '^84' AND v_vn_digits ~ '^[1-9][0-9]{7,14}$' THEN
        v_kind := 'phone';
      END IF;
    ELSIF v_vn_digits ~ '^0084(?:[35789][0-9]{8}|2[0-9]{9}|1[2689][0-9]{8})$' THEN
      v_kind := 'phone';
    ELSIF NOT v_bank_hint AND NOT v_id_hint AND NOT v_tax_hint
          AND v_vn_digits ~ '^00[1-9]' AND v_vn_digits !~ '^0084'
          AND ((v_digit_len BETWEEN 13 AND 15) OR v_match ~ '\([0-9]{1,4}\)') THEN
      v_kind := 'phone';
    ELSIF v_vn_digits ~ '^84(?:[35789][0-9]{8}|2[0-9]{9})$' AND NOT v_bank_hint AND NOT v_tax_hint THEN
      v_kind := 'phone';
    ELSIF v_vn_digits ~ '^0(?:3[2-9]|5[25689]|7[06789]|8[1-9]|9[0-9])[0-9]{7}$' THEN
      IF v_bank_hint THEN
        v_kind := 'bank_account';
      ELSIF v_tax_hint THEN
        v_kind := 'tax_code';
      ELSE
        v_kind := 'phone';
      END IF;
    ELSIF v_vn_digits ~ '^02[0-9]{9}$' THEN
      v_kind := CASE WHEN v_bank_hint THEN 'bank_account' ELSE 'phone' END;
    ELSIF v_match ~ ('^\([2-9][0-9]{2}\)[' || v_inline || '.-]?[2-9][0-9]{2}[' || v_inline || '.-]?[0-9]{4}$')
       OR v_match ~ '^[2-9][0-9]{2}[.-][2-9][0-9]{2}[.-][0-9]{4}$' THEN
      v_kind := CASE WHEN v_bank_hint THEN 'bank_account' WHEN v_tax_hint THEN 'tax_code' ELSE 'phone' END;
    ELSIF v_phone_hint AND (v_vn_digits ~ '^0[0-9]{9,10}$' OR v_vn_digits ~ '^[2-9][0-9]{9}$') THEN
      v_kind := 'phone';
    END IF;

    -- 2. Tax codes (10/13-digit MST), 12-digit CCCD / 9-digit CMND, and 8-20 digit bank accounts / cards (never +-prefixed).
    IF v_kind IS NULL AND NOT v_has_plus THEN
      IF v_digit_len = 8 THEN
        -- Unlabelled 8-digit numbers have too many price/date/order near-misses; require explicit account/ID/tax context.
        IF v_bank_hint THEN
          v_kind := 'bank_account';
        ELSIF v_id_hint THEN
          v_kind := 'national_id';
        ELSIF v_tax_hint THEN
          v_kind := 'tax_code';
        END IF;
      ELSIF v_digit_len = 9 THEN
        IF v_bank_hint THEN
          v_kind := 'bank_account';
        ELSIF v_tax_hint THEN
          v_kind := 'tax_code';
        ELSIF v_id_hint OR v_vn_digits ~ '^[0-3]' THEN
          v_kind := 'national_id';
        ELSE
          v_kind := 'bank_account';
        END IF;
      ELSIF v_digit_len = 10 THEN
        IF v_tax_hint THEN
          v_kind := 'tax_code';
        ELSIF v_bank_hint THEN
          v_kind := 'bank_account';
        ELSIF v_id_hint THEN
          v_kind := 'national_id';
        ELSIF v_vn_digits ~ '^0[1-9]' THEN
          v_kind := 'tax_code';
        ELSIF v_vn_digits ~ '^(?:[1-5][0-9]|6[0-4])' THEN
          v_mst_sum :=
            pg_catalog.substr(v_vn_digits, 1, 1)::int * 31
            + pg_catalog.substr(v_vn_digits, 2, 1)::int * 29
            + pg_catalog.substr(v_vn_digits, 3, 1)::int * 23
            + pg_catalog.substr(v_vn_digits, 4, 1)::int * 19
            + pg_catalog.substr(v_vn_digits, 5, 1)::int * 17
            + pg_catalog.substr(v_vn_digits, 6, 1)::int * 13
            + pg_catalog.substr(v_vn_digits, 7, 1)::int * 7
            + pg_catalog.substr(v_vn_digits, 8, 1)::int * 5
            + pg_catalog.substr(v_vn_digits, 9, 1)::int * 3;
          v_mst_check := 10 - (v_mst_sum % 11);
          v_mst_valid := v_mst_check BETWEEN 0 AND 9 AND v_mst_check = pg_catalog.substr(v_vn_digits, 10, 1)::int;
          v_kind := CASE WHEN v_mst_valid THEN 'tax_code' ELSE 'bank_account' END;
        ELSE
          v_kind := 'bank_account';
        END IF;
      ELSIF v_digit_len = 11 THEN
        v_kind := 'bank_account';
      ELSIF v_digit_len = 12 THEN
        IF v_bank_hint THEN
          v_kind := 'bank_account';
        ELSIF v_tax_hint THEN
          v_kind := 'tax_code';
        ELSIF v_id_hint OR v_vn_digits ~ '^0(?:0[1-9]|[1-8][0-9]|9[0-6])' THEN
          v_kind := 'national_id';
        ELSE
          v_kind := 'bank_account';
        END IF;
      ELSIF v_digit_len = 13 AND (v_match ~ '^[0-9]{10}-[0-9]{3}$' OR v_tax_hint) THEN
        v_kind := CASE WHEN v_bank_hint THEN 'bank_account' ELSE 'tax_code' END;
      ELSIF v_digit_len BETWEEN 13 AND 20 THEN
        v_kind := 'bank_account';
      END IF;
    END IF;

    IF v_kind IS NOT NULL THEN
      kind := v_kind;
      start_pos := v_start;
      end_pos := v_end;
      match_text := v_match;
      RETURN NEXT;
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.text_detect(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.text_detect(text) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_kernel.text_redact_spans(
  p_text text,
  p_starts integer[],
  p_kinds text[],
  p_marks text[]
)
RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ws constant text := ' ' || pg_catalog.chr(9) || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(160) || pg_catalog.chr(8199) || pg_catalog.chr(8239) || pg_catalog.chr(65279);
  v_count integer;
  v_out text := '';
  v_cursor integer := 1;
  v_len integer;
  i integer;
  d record;
BEGIN
  IF p_starts IS NULL OR p_kinds IS NULL OR p_marks IS NULL THEN
    RAISE EXCEPTION 'TEXT_REDACT_ARGS' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(pg_catalog.array_ndims(p_starts), 1) > 1
     OR COALESCE(pg_catalog.array_ndims(p_kinds), 1) > 1
     OR COALESCE(pg_catalog.array_ndims(p_marks), 1) > 1 THEN
    RAISE EXCEPTION 'TEXT_REDACT_ARGS' USING ERRCODE = '22023';
  END IF;
  IF (pg_catalog.array_lower(p_starts, 1) IS NOT NULL AND pg_catalog.array_lower(p_starts, 1) <> 1)
     OR (pg_catalog.array_lower(p_kinds, 1) IS NOT NULL AND pg_catalog.array_lower(p_kinds, 1) <> 1)
     OR (pg_catalog.array_lower(p_marks, 1) IS NOT NULL AND pg_catalog.array_lower(p_marks, 1) <> 1) THEN
    RAISE EXCEPTION 'TEXT_REDACT_ARGS' USING ERRCODE = '22023';
  END IF;

  v_count := COALESCE(pg_catalog.array_length(p_starts, 1), 0);
  IF v_count <> COALESCE(pg_catalog.array_length(p_kinds, 1), 0)
     OR v_count <> COALESCE(pg_catalog.array_length(p_marks, 1), 0) THEN
    RAISE EXCEPTION 'TEXT_REDACT_ARGS' USING ERRCODE = '22023';
  END IF;

  FOR i IN 1..v_count LOOP
    IF p_starts[i] IS NULL OR p_starts[i] < 1 THEN
      RAISE EXCEPTION 'TEXT_REDACT_START' USING ERRCODE = '22023';
    END IF;
    IF p_kinds[i] IS NULL OR p_kinds[i] NOT IN ('email', 'phone', 'national_id', 'tax_code', 'bank_account') THEN
      RAISE EXCEPTION 'TEXT_REDACT_KIND' USING ERRCODE = '22023';
    END IF;
    IF p_marks[i] IS NULL OR pg_catalog.btrim(p_marks[i], v_ws) = '' OR pg_catalog.char_length(p_marks[i]) > 200 THEN
      RAISE EXCEPTION 'TEXT_REDACT_MARK' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  IF p_text IS NULL OR v_count = 0 THEN
    RETURN p_text;
  END IF;

  v_len := pg_catalog.char_length(p_text);
  -- Re-detect on p_text; replace only matches whose (start_pos, kind) matches a confirmed request.
  FOR d IN
    SELECT td.start_pos, td.end_pos, req.mark
    FROM crove_kernel.text_detect(p_text) AS td
    JOIN ROWS FROM (pg_catalog.unnest(p_starts), pg_catalog.unnest(p_kinds), pg_catalog.unnest(p_marks)) WITH ORDINALITY AS req(start_pos, kind, mark, ord)
      ON req.start_pos = td.start_pos AND req.kind = td.kind
    ORDER BY td.start_pos, req.ord
  LOOP
    IF d.start_pos >= v_cursor THEN
      v_out := v_out || pg_catalog.substr(p_text, v_cursor, d.start_pos - v_cursor) || d.mark;
      v_cursor := d.end_pos;
    END IF;
  END LOOP;

  IF v_cursor = 1 THEN
    RETURN p_text;
  END IF;
  IF v_cursor <= v_len THEN
    v_out := v_out || pg_catalog.substr(p_text, v_cursor);
  END IF;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.text_redact_spans(text, integer[], text[], text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.text_redact_spans(text, integer[], text[], text[]) TO crove_tenant;
