-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #4001, Slice 1): code-only detector for unknown sensitive values in free text and span-verified redaction.
-- Idempotent; applied files stay untouched.
--
-- crove_kernel.text_detect(p_text text)
--   Returns (kind text, start_pos integer, end_pos integer, match_text text) in ascending start_pos order, non-overlapping.
--   - Decoupled two-pass O(N) architecture (no combined email|numeric alternation backtracking):
--     Pass 1 splits linearly on '@' (skipped when strpos(p_text, '@') = 0) and inspects only bounded [at-68..at+258] windows;
--     Pass 2 masks matched email spans with '@' via 250-char chunks and scans v_num_pat alone with a bounded <=8-row window
--     for right context, a rolling <=256-char left buffer, and independent token-scoped HTTP(S) URL tracking.
--   - start_pos is 1-based Unicode character index; end_pos is 1-based exclusive end (pg_catalog.substr(p_text, start_pos, end_pos - start_pos) = match_text).
--   - kind is one of: 'email', 'phone', 'national_id', 'tax_code', 'bank_account'.
--   - Reuses the inline space set, non-ASCII Latin letters, email boundaries, +84/0/84 phone rules, and 8-20 digit bounds of
--     crove_kernel.text_mention_pattern (20261122040000), while rejecting near-misses (prices, dot-thousands, years, short counts,
--     dates, percentages, timestamps, IPv4, UUIDs, URLs, meeting numbers).
--
-- crove_kernel.text_redact_spans(p_text text, p_starts integer[], p_kinds text[], p_marks text[])
--   Re-runs crove_kernel.text_detect(p_text) and replaces only detected spans whose (start_pos, kind) matches a requested item,
--   using O(N) 250-char chunked reconstruction with literal mark text (never trusting client offsets or rescanning p_text per span).
--
-- Both are pure IMMUTABLE PARALLEL SAFE SECURITY INVOKER functions with pinned search_path = pg_catalog, pg_temp,
-- revoked from PUBLIC and granted to crove_tenant (matching text_mentions / text_redact).
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.text_detect(p_text text)
RETURNS TABLE(kind text, start_pos integer, end_pos integer, match_text text)
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ws constant text := ' ' || pg_catalog.chr(9) || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(160) || pg_catalog.chr(8199) || pg_catalog.chr(8239) || pg_catalog.chr(65279);
  -- Same inline spaces and non-ASCII Latin letter ranges as crove_kernel.text_mention_pattern (20261122040000).
  v_inline constant text := ' ' || pg_catalog.chr(160) || pg_catalog.chr(8199) || pg_catalog.chr(8239) || pg_catalog.chr(65279);
  v_letters constant text := pg_catalog.chr(192) || '-' || pg_catalog.chr(214) || pg_catalog.chr(216) || '-' || pg_catalog.chr(246)
    || pg_catalog.chr(248) || '-' || pg_catalog.chr(591) || pg_catalog.chr(768) || '-' || pg_catalog.chr(879)
    || pg_catalog.chr(7680) || '-' || pg_catalog.chr(7935);
  -- Single inline separator only: keeps spaced numeric columns and list numbers separated (matching text_mention_pattern).
  v_sep constant text := '[' || v_inline || '.-]';
  v_url_break constant text := v_ws || '<>"`';
  c_url_break_re constant text := '[' || v_url_break || ']';
  c_rev_no_break_re constant text := '^[^' || v_url_break || ']*';
  c_http_re constant text := '(?:^|[^a-z0-9_' || v_letters || '])https?://';
  c_rev_http_re constant text := '//:s?ptth(?=$|[^a-z0-9_' || v_letters || '])';
  -- Disjoint local-part character sets plus optional trailing '-' at the end of an unquoted local part.
  v_local_edge constant text := 'a-z0-9_+' || v_letters;
  v_local_inner constant text := '!#$%&''*/=?^`{|}~-';
  v_local_seg constant text := '[' || v_local_edge || ']+(?:[' || v_local_inner || ']+[' || v_local_edge || ']+)*';
  v_dom_char constant text := 'a-z0-9' || v_letters;
  v_dom_label constant text := '[' || v_dom_char || ']+(?:-+[' || v_dom_char || ']+)*';
  v_tld constant text := '(?:xn--[a-z0-9]+|[a-z' || v_letters || ']{2,63})';
  c_email_local_pre_re constant text := '[' || v_local_edge || '-]$';
  c_email_dom_pre_re constant text := '^[' || v_dom_char || ']';
  c_email_local_end_re constant text := '(' || v_local_seg || '(?:\.' || v_local_seg || ')*-*)$';
  c_email_dom_start_re constant text := '^((?:' || v_dom_label || '\.)+' || v_tld || ')';
  c_email_prev1_re constant text := '[' || v_local_edge || ']';
  c_email_prev_inner_re constant text := '[.' || v_local_inner || ']';
  c_email_prev2_re constant text := '[' || v_local_edge || '.' || v_local_inner || ']';
  c_email_next1_re constant text := '^[a-z0-9_' || v_letters || '-]$';
  c_email_after_dot_re constant text := '^\.[a-z0-9_' || v_letters || ']';
  -- Inline digit spans (newlines always part adjacent numbers; optional area/country code parens or + prefix).
  v_num_prefix constant text := '(?:\(\+?[0-9]{1,4}\)(?:' || v_sep || '?\(0\))?' || v_sep || '?|\+[0-9]{1,3}(?:' || v_sep || '?\([0-9]{1,4}\))?' || v_sep || '?|(?:00)?84' || v_sep || '?\(0\)' || v_sep || '?)';
  v_num_pat constant text := '(?:' || v_num_prefix || '[0-9](?:' || v_sep || '?[0-9]){4,}|[0-9](?:' || v_sep || '?[0-9]){7,})(?![a-z0-9_+' || v_letters || '@])';
  c_word_re constant text := '[a-z0-9_' || v_letters || ']';
  c_word_at_re constant text := '[a-z0-9_' || v_letters || '@]';
  c_letter_re constant text := '[a-z' || v_letters || ']';
  c_meeting_re constant text := '(?:^|[^a-z0-9' || v_letters || '])(?:meeting|zoom|cuộc họp|cuoc hop|buổi họp|buoi hop|phòng họp|phong hop|mã họp|ma hop|mã cuộc họp|ma cuoc hop|id cuộc họp|id cuoc hop|meeting id|meeting no|meeting number)[' || v_inline || ':#.-]*(?:số|so|id|no|#)?[' || v_inline || ':#.-]*$';
  c_tax_re constant text := '(?:^|[^a-z0-9' || v_letters || '])(?:mst|mã số thuế|ma so thue|tax[' || v_inline || '_-]*code|tax[' || v_inline || '_-]*id)[' || v_inline || ':#.-]*(?:số|so)?[' || v_inline || ':#.-]*$';
  c_tin_re constant text := '(?:^|[^A-Za-z0-9' || v_letters || '])TIN[' || v_inline || ':#.-]*(?:số|so|SỐ|SO|no|No|NO|#)?[' || v_inline || ':#.-]*$';
  c_tin_excl_re constant text := '(?:^|[^a-z0-9' || v_letters || '])(?:thông|thong|nhắn|nhan|bản|ban|tín)[' || v_inline || ']+tin[' || v_inline || ':#.-]*(?:số|so|no|#)?[' || v_inline || ':#.-]*$';
  c_id_re constant text := '(?:^|[^a-z0-9' || v_letters || '])(?:cccd|cmnd|căn cước|can cuoc|chứng minh|chung minh|national[' || v_inline || '_-]*id|id[' || v_inline || '_-]*card|số định danh|so dinh danh)(?:[' || v_inline || ':#.-]+(?:công dân|cong dan|nhân dân|nhan dan|số|so|cũ|cu|mới|moi)){0,2}[' || v_inline || ':#.-]*$';
  c_bank_re constant text := '(?:^|[^a-z0-9' || v_letters || '])(?:stk|số tài khoản|so tai khoan|tài khoản|tai khoan|tk|số thẻ|so the|thẻ|visa|mastercard|napas|atm|iban|bank[' || v_inline || '_-]*account|account[' || v_inline || '_-]*(?:no|number|#)?|card[' || v_inline || '_-]*(?:no|number|#)?|acct)(?:[' || v_inline || ':#.-]+(?:ngân hàng|ngan hang|số|so|acb|vcb|vietcombank|tcb|techcombank|bidv|ctg|vietinbank|mb|mbbank|vpb|vpbank|tpb|tpbank|stb|sacombank|agribank|vib|hdbank|ocb|shb|msb|eximbank|seabank|vnd|vnđ|usd)){0,2}[' || v_inline || ':#.-]*$';
  c_phone_re constant text := '(?:^|[^a-z0-9' || v_letters || '])(?:sđt|sdt|điện thoại|dien thoai|số điện thoại|so dien thoai|zalo|hotline|tel|phone|mobile|call|gọi|goi|liên hệ|lien he|alô|alo)[' || v_inline || ':#.-]*(?:số|so)?[' || v_inline || ':#.-]*$';
  c_curr_pre_re constant text := '(?:^|[^a-z0-9' || v_letters || '])(?:usd|vnd|vnđ|eur|jpy|gbp|krw|aud|sgd|cny|rmb)[' || v_inline || ':]*$';
  c_curr_suf_re constant text := '^[' || v_inline || ']*(?:₫|\$|€|£|¥|(?:vnd|vnđ|đồng(?![' || v_inline || ']+(?:ý|thời|nghiệp|hồ)(?![a-z0-9_' || v_letters || ']))|đ|usd|eur|jpy|gbp|krw|aud|sgd|cny|rmb|triệu|tỷ|tỉ|nghìn|ngàn|xu)(?![a-z0-9_' || v_letters || ']))';
  c_dot_float_re constant text := '^(?:[0-9]{1,2}\.[0-9]{5,}|[0-9]{6,}\.[0-9]{1,2})$';
  c_dot_group_re constant text := '^(?:[1-9][0-9]{0,2}(?:\.[0-9]{3}){2,}|(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3})$';
  c_date_delim_re constant text := '^(?:(?:0?[1-9]|[12][0-9]|3[01])' || v_sep || '(?:0?[1-9]|1[0-2])' || v_sep || '(?:19|20)[0-9]{2}(?:' || v_sep || '(?:[01]?[0-9]|2[0-3]))?|(?:0?[1-9]|1[0-2])' || v_sep || '(?:0?[1-9]|[12][0-9]|3[01])' || v_sep || '(?:19|20)[0-9]{2}(?:' || v_sep || '(?:[01]?[0-9]|2[0-3]))?|(?:19|20)[0-9]{2}' || v_sep || '(?:0?[1-9]|1[0-2])' || v_sep || '(?:0?[1-9]|[12][0-9]|3[01])(?:' || v_sep || '(?:[01]?[0-9]|2[0-3]))?|(?:19|20)[0-9]{2}' || v_sep || '(?:19|20)[0-9]{2})$';
  c_date_compact_re constant text := '^(?:(?:19|20)[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])|(?:0[1-9]|[12][0-9]|3[01])(?:0[1-9]|1[0-2])(?:19|20)[0-9]{2})$';
  c_nanp_re constant text := '^(?:\([2-9][0-9]{2}\)' || v_sep || '?[2-9][0-9]{2}' || v_sep || '?[0-9]{4}|[2-9][0-9]{2}[.-][2-9][0-9]{2}[.-][0-9]{4})$';
  v_has_at boolean;
  v_has_digit boolean;
  v_e_starts integer[];
  v_e_ends integer[];
  v_e_matches text[];
  v_e_count integer := 0;
  v_e_has_overlap boolean := false;
  v_last_e_end integer := 1;
  v_b1 text := '';
  v_b2 text := '';
  v_mask text := '';
  v_e_cur refcursor;
  v_ec_has boolean := false;
  v_ec_start integer;
  v_ec_end integer;
  v_ec_match text;
  v_num_input text;
  v_pos integer := 1;
  v_in_url boolean := false;
  v_start integer;
  v_end integer;
  v_match text;
  v_abs_match text;
  v_match_len integer;
  v_left_ctx text := '';
  v_left_tail2 text;
  v_right_ctx text;
  v_prev1 text;
  v_prev2 text;
  v_next1 text;
  v_next2 text;
  v_after text;
  v_line_before text;
  v_line_before_nfc text;
  v_line_after text;
  v_url_before text;
  v_token text;
  v_digits text;
  v_vn_digits text;
  v_digit_len integer;
  v_has_plus boolean;
  v_has_dot boolean;
  v_has_ctx_letters boolean;
  v_ctx_before text;
  v_tax_hint boolean;
  v_id_hint boolean;
  v_bank_hint boolean;
  v_phone_hint boolean;
  v_mst_sum integer;
  v_mst_check integer;
  v_mst_valid boolean;
  v_kind text;
  i integer;
  r record;
BEGIN
  IF p_text IS NULL OR p_text = '' THEN
    RETURN;
  END IF;

  v_has_at := pg_catalog.strpos(p_text, '@') > 0;
  v_has_digit := p_text ~ '[0-9]';
  IF NOT v_has_at AND NOT v_has_digit THEN
    RETURN;
  END IF;

  -- Pass 1: linear '@' split with bounded [at-68..at+258] windows (no regex alternation over dotted tokens).
  IF v_has_at THEN
    WITH segs AS (
      SELECT
        s.ord,
        pg_catalog.char_length(s.txt) AS seg_len,
        pg_catalog.right(s.txt, 68) AS seg_tail,
        pg_catalog.left(s.txt, 258) AS seg_head
      FROM pg_catalog.string_to_table(p_text, '@') WITH ORDINALITY AS s(txt, ord)
    ),
    win AS (
      SELECT
        ord,
        seg_len,
        seg_tail,
        COALESCE(pg_catalog.sum(seg_len + 1) OVER (ORDER BY ord ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) + seg_len + 1 AS at_pos,
        pg_catalog.lag(seg_tail) OVER (ORDER BY ord) AS prev_tail,
        pg_catalog.lead(seg_len) OVER (ORDER BY ord) AS next_len,
        pg_catalog.lead(seg_head) OVER (ORDER BY ord) AS next_head,
        pg_catalog.lead(seg_head, 2) OVER (ORDER BY ord) AS next_next_head,
        pg_catalog.lead(ord, 2) OVER (ORDER BY ord) AS next_next_ord
      FROM segs
    ),
    cands AS (
      SELECT
        w.ord,
        w.at_pos::integer AS at_pos,
        w.seg_len,
        w.seg_tail,
        w.prev_tail,
        w.next_len,
        w.next_head,
        w.next_next_head,
        w.next_next_ord,
        (pg_catalog.regexp_match(w.seg_tail, c_email_local_end_re, 'i'))[1] AS local_txt,
        (pg_catalog.regexp_match(w.next_head, c_email_dom_start_re, 'i'))[1] AS dom_txt
      FROM win w
      WHERE w.next_head IS NOT NULL
        AND w.seg_len > 0
        AND w.next_len > 0
        AND pg_catalog.strpos(w.next_head, '.') > 0
        AND w.seg_tail ~* c_email_local_pre_re
        AND w.next_head ~* c_email_dom_pre_re
    ),
    parts AS (
      SELECT
        c.ord,
        c.at_pos,
        c.local_txt,
        c.dom_txt,
        pg_catalog.char_length(c.local_txt) AS local_len,
        pg_catalog.char_length(c.dom_txt) AS dom_len,
        pg_catalog.right(
          (CASE WHEN c.ord > 1 AND c.seg_len <= 68 THEN COALESCE(pg_catalog.right(c.prev_tail, 1), '') || '@' ELSE '' END)
            || pg_catalog.left(c.seg_tail, pg_catalog.char_length(c.seg_tail) - pg_catalog.char_length(c.local_txt)),
          2
        ) AS before2,
        pg_catalog.left(
          pg_catalog.substr(c.next_head, pg_catalog.char_length(c.dom_txt) + 1, 2)
            || CASE WHEN c.next_len <= 258 AND c.next_next_ord IS NOT NULL THEN '@' || COALESCE(pg_catalog.left(c.next_next_head, 1), '') ELSE '' END,
          2
        ) AS after2
      FROM cands c
      WHERE c.local_txt IS NOT NULL AND c.dom_txt IS NOT NULL
    ),
    valid AS (
      SELECT
        p.at_pos - p.local_len AS s_pos,
        p.at_pos + 1 + p.dom_len AS e_pos,
        p.local_txt || '@' || p.dom_txt AS m_txt
      FROM parts p
      WHERE p.local_len <= 64
        AND p.dom_len <= 255
        AND p.local_len + 1 + p.dom_len <= 320
        AND NOT (
          p.before2 <> '' AND (
            pg_catalog.right(p.before2, 1) ~* c_email_prev1_re
            OR (
              pg_catalog.right(p.before2, 1) ~ c_email_prev_inner_re
              AND pg_catalog.char_length(p.before2) = 2
              AND pg_catalog.left(p.before2, 1) ~* c_email_prev2_re
            )
          )
        )
        AND NOT (
          p.after2 <> '' AND (
            pg_catalog.left(p.after2, 1) ~* c_email_next1_re
            OR p.after2 ~* c_email_after_dot_re
          )
        )
    ),
    ordered AS (
      SELECT
        v.s_pos,
        v.e_pos,
        v.m_txt,
        COALESCE(pg_catalog.lag(v.e_pos) OVER (ORDER BY v.s_pos), 1) AS prev_end
      FROM valid v
    )
    SELECT
      pg_catalog.array_agg(o.s_pos ORDER BY o.s_pos),
      pg_catalog.array_agg(o.e_pos ORDER BY o.s_pos),
      pg_catalog.array_agg(o.m_txt ORDER BY o.s_pos),
      COALESCE(pg_catalog.bool_or(o.s_pos < o.prev_end), false)
    INTO v_e_starts, v_e_ends, v_e_matches, v_e_has_overlap
    FROM ordered o;

    v_e_count := COALESCE(pg_catalog.array_length(v_e_starts, 1), 0);

    IF v_e_has_overlap AND v_e_count > 1 THEN
      -- Resolve rare adjacent '@' overlaps via a 2-level O(N) bitmask (avoids O(N^2) array reallocation).
      FOR i IN 1..v_e_count LOOP
        IF v_e_starts[i] >= v_last_e_end THEN
          v_last_e_end := v_e_ends[i];
          v_b1 := v_b1 || '1';
        ELSE
          v_b1 := v_b1 || '0';
        END IF;
        IF pg_catalog.length(v_b1) >= 128 THEN
          v_b2 := v_b2 || v_b1;
          v_b1 := '';
          IF pg_catalog.length(v_b2) >= 16384 THEN
            v_mask := v_mask || v_b2;
            v_b2 := '';
          END IF;
        END IF;
      END LOOP;
      v_mask := v_mask || v_b2 || v_b1;

      SELECT
        pg_catalog.array_agg(t.s ORDER BY t.ord),
        pg_catalog.array_agg(t.e ORDER BY t.ord),
        pg_catalog.array_agg(t.m ORDER BY t.ord)
      INTO v_e_starts, v_e_ends, v_e_matches
      FROM ROWS FROM (
        pg_catalog.unnest(v_e_starts),
        pg_catalog.unnest(v_e_ends),
        pg_catalog.unnest(v_e_matches),
        pg_catalog.regexp_split_to_table(v_mask, '')
      ) WITH ORDINALITY AS t(s, e, m, flag, ord)
      WHERE t.flag = '1';

      v_e_count := COALESCE(pg_catalog.array_length(v_e_starts, 1), 0);
    END IF;
  END IF;

  IF NOT v_has_digit THEN
    IF v_e_count > 0 THEN
      RETURN QUERY
      SELECT 'email'::text, t.s, t.e, t.m
      FROM ROWS FROM (
        pg_catalog.unnest(v_e_starts),
        pg_catalog.unnest(v_e_ends),
        pg_catalog.unnest(v_e_matches)
      ) WITH ORDINALITY AS t(s, e, m, ord)
      ORDER BY t.ord;
    END IF;
    RETURN;
  END IF;

  -- Mask emitted email spans with equal-length '@' runs so Pass 2 preserves character indices and stops numeric runs cleanly at email starts.
  IF v_e_count = 0 THEN
    v_num_input := p_text;
  ELSE
    WITH bounds AS (
      SELECT
        m.ord::bigint AS span_ord,
        m.s_pos,
        m.e_pos,
        pg_catalog.repeat('@', m.e_pos - m.s_pos) AS mask_txt,
        COALESCE(pg_catalog.lag(m.e_pos) OVER (ORDER BY m.ord), 1) AS prev_end
      FROM ROWS FROM (
        pg_catalog.unnest(v_e_starts),
        pg_catalog.unnest(v_e_ends)
      ) WITH ORDINALITY AS m(s_pos, e_pos, ord)
    ),
    gaps AS (
      SELECT span_ord, 0 AS sub_ord, prev_end AS g_from, bounds.s_pos AS g_to, NULL::text AS mask_txt
      FROM bounds WHERE prev_end < bounds.s_pos
      UNION ALL
      SELECT span_ord, 1 AS sub_ord, bounds.s_pos AS g_from, bounds.e_pos AS g_to, mask_txt
      FROM bounds
      UNION ALL
      SELECT
        (v_e_count + 1)::bigint AS span_ord,
        0 AS sub_ord,
        v_e_ends[v_e_count] AS g_from,
        pg_catalog.char_length(p_text) + 1 AS g_to,
        NULL::text AS mask_txt
      WHERE v_e_ends[v_e_count] <= pg_catalog.char_length(p_text)
    ),
    chunks AS (
      SELECT n::integer AS c_idx, m[1] AS txt
      FROM pg_catalog.regexp_matches(p_text, '.{1,250}', 'g') WITH ORDINALITY AS t(m, n)
    ),
    pieces AS (
      SELECT g.span_ord, g.sub_ord, 0::integer AS c_idx, g.mask_txt AS piece
      FROM gaps g
      WHERE g.mask_txt IS NOT NULL
      UNION ALL
      SELECT
        g.span_ord,
        g.sub_ord,
        s.c_idx,
        pg_catalog.substr(
          c.txt,
          GREATEST(g.g_from, (s.c_idx - 1) * 250 + 1) - (s.c_idx - 1) * 250,
          LEAST(g.g_to, s.c_idx * 250 + 1) - GREATEST(g.g_from, (s.c_idx - 1) * 250 + 1)
        ) AS piece
      FROM gaps g
      CROSS JOIN LATERAL pg_catalog.generate_series((g.g_from - 1) / 250 + 1, (g.g_to - 2) / 250 + 1) AS s(c_idx)
      JOIN chunks c ON c.c_idx = s.c_idx
      WHERE g.mask_txt IS NULL AND g.g_from < g.g_to
    )
    SELECT COALESCE(pg_catalog.string_agg(piece, '' ORDER BY span_ord, sub_ord, c_idx), '')
    INTO v_num_input
    FROM pieces;

    OPEN v_e_cur NO SCROLL FOR
      SELECT t.s, t.e, t.m
      FROM ROWS FROM (
        pg_catalog.unnest(v_e_starts),
        pg_catalog.unnest(v_e_ends),
        pg_catalog.unnest(v_e_matches)
      ) WITH ORDINALITY AS t(s, e, m, ord)
      ORDER BY t.ord;
    FETCH v_e_cur INTO v_ec_start, v_ec_end, v_ec_match;
    v_ec_has := FOUND;
  END IF;

  -- Pass 2: numeric candidate scan (no email alternation) merged sequentially with Pass 1 emails by start_pos.
  FOR r IN
    SELECT
      t.gap_len,
      t.gap_tail,
      t.gap_has_break,
      t.gap_ends_url,
      t.match_txt,
      COALESCE(
        pg_catalog.left(
          pg_catalog.string_agg(t.gap_head || COALESCE(pg_catalog.left(t.match_txt, 40), ''), '')
            OVER (ORDER BY t.ord ROWS BETWEEN 1 FOLLOWING AND 8 FOLLOWING),
          40
        ),
        ''
      ) AS right_ctx
    FROM (
      SELECT
        pg_catalog.char_length(raw.gap) AS gap_len,
        pg_catalog.right(raw.gap, 256) AS gap_tail,
        pg_catalog.left(raw.gap, 40) AS gap_head,
        raw.gap ~ c_url_break_re AS gap_has_break,
        CASE
          WHEN pg_catalog.strpos(raw.gap, '://') > 0 THEN
            CASE
              WHEN raw.gap ~ c_url_break_re
                THEN pg_catalog.regexp_substr(pg_catalog.reverse(raw.gap), c_rev_no_break_re) ~* c_rev_http_re
              ELSE raw.gap ~* c_http_re
            END
          ELSE false
        END AS gap_ends_url,
        raw.m[1] AS match_txt,
        raw.ord
      FROM ROWS FROM (
        pg_catalog.regexp_split_to_table(v_num_input, v_num_pat, 'i'),
        pg_catalog.regexp_matches(v_num_input, v_num_pat, 'gi')
      ) WITH ORDINALITY AS raw(gap, m, ord)
    ) AS t
    ORDER BY t.ord
  LOOP
    EXIT WHEN r.match_txt IS NULL;

    IF r.gap_has_break THEN
      v_in_url := r.gap_ends_url;
    ELSIF r.gap_ends_url THEN
      v_in_url := true;
    END IF;

    -- Advance rolling <=256-char left context across this gap before computing candidate boundaries.
    IF r.gap_len >= 256 THEN
      v_left_ctx := r.gap_tail;
    ELSIF r.gap_len > 0 THEN
      v_left_ctx := pg_catalog.right(v_left_ctx || r.gap_tail, 256);
    END IF;

    v_start := v_pos + r.gap_len;
    v_match := r.match_txt;
    v_match_len := pg_catalog.char_length(v_match);
    v_end := v_start + v_match_len;
    v_pos := v_end;

    v_left_tail2 := pg_catalog.right(v_left_ctx, 2);
    v_prev1 := pg_catalog.right(v_left_tail2, 1);
    v_prev2 := CASE WHEN pg_catalog.char_length(v_left_tail2) = 2 THEN pg_catalog.left(v_left_tail2, 1) ELSE '' END;

    v_right_ctx := r.right_ctx;
    v_after := pg_catalog.left(v_right_ctx, 2);
    v_next1 := pg_catalog.left(v_after, 1);
    v_next2 := CASE WHEN pg_catalog.char_length(v_after) = 2 THEN pg_catalog.right(v_after, 1) ELSE '' END;

    -- Bounded line-scoped context before advancing v_left_ctx across v_match.
    v_url_before := CASE
      WHEN pg_catalog.strpos(v_left_ctx, pg_catalog.chr(10)) > 0 OR pg_catalog.strpos(v_left_ctx, pg_catalog.chr(13)) > 0
        THEN pg_catalog.regexp_replace(v_left_ctx, '^.*[\r\n]', '')
      ELSE v_left_ctx
    END;
    v_line_before := pg_catalog.right(v_url_before, 64);
    v_line_after := CASE
      WHEN pg_catalog.strpos(v_right_ctx, pg_catalog.chr(10)) > 0 OR pg_catalog.strpos(v_right_ctx, pg_catalog.chr(13)) > 0
        THEN pg_catalog.regexp_replace(v_right_ctx, '[\r\n].*$', '')
      ELSE v_right_ctx
    END;
    v_left_ctx := CASE
      WHEN v_match_len >= 256 THEN pg_catalog.right(v_match, 256)
      ELSE pg_catalog.right(v_left_ctx || v_match, 256)
    END;

    -- Suppress candidates inside HTTP(S) URLs regardless of URL length; reset URL state if match crossed a token break.
    IF v_in_url THEN
      IF v_match ~ c_url_break_re THEN
        v_in_url := false;
      END IF;
      CONTINUE;
    END IF;
    IF v_match ~ c_url_break_re THEN
      v_in_url := false;
    END IF;

    -- Digit run candidate: enforce boundary checks and extract raw digits.
    IF v_prev1 <> '' AND v_prev1 ~* c_word_re THEN
      CONTINUE;
    END IF;
    IF v_next1 <> '' AND (
      v_next1 ~* c_word_at_re
      OR (v_next1 ~ v_sep AND v_next2 ~ '^[0-9]$')
    ) THEN
      CONTINUE;
    END IF;

    v_digits := pg_catalog.regexp_replace(v_match, '[^0-9]', '', 'g');
    IF pg_catalog.length(v_digits) NOT BETWEEN 8 AND 20 THEN
      CONTINUE;
    END IF;

    v_has_plus := pg_catalog.left(v_match, 1) = '+' OR pg_catalog.left(v_match, 2) = '(+';
    v_vn_digits := CASE
      WHEN (v_has_plus OR pg_catalog.left(v_digits, 4) = '0084' OR v_match ~ ('^84[' || v_inline || '.-]*\(0'))
           AND v_digits ~ '^(?:00)?840(?:[35789][0-9]{8}|2[0-9]{9}|1[2689][0-9]{8})$'
        THEN pg_catalog.regexp_replace(v_digits, '^(00)?840', '\184')
      ELSE v_digits
    END;
    v_digit_len := pg_catalog.length(v_vn_digits);
    IF v_digit_len < 8 THEN
      CONTINUE;
    END IF;

    -- Reject numbers inside UUID tokens (gated by cheap hex + hyphen checks).
    IF v_match ~ '^[0-9a-fA-F-]+$' AND (pg_catalog.strpos(v_url_before, '-') > 0 OR pg_catalog.strpos(v_line_after, '-') > 0) THEN
      v_token := pg_catalog.regexp_replace(v_url_before, '^.*[^a-zA-Z0-9_-]', '')
        || v_match
        || pg_catalog.regexp_replace(v_line_after, '[^a-zA-Z0-9_-].*$', '');
      IF v_token ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        CONTINUE;
      END IF;
    END IF;

    -- Reject percentages (e.g. 12345678%, 100000 %).
    IF v_line_after <> '' AND pg_catalog.strpos(v_line_after, '%') > 0 AND v_line_after ~ ('^[' || v_inline || ']*%') THEN
      CONTINUE;
    END IF;

    -- Reject negative non-zero-prefixed numbers (e.g. -123456789).
    IF NOT v_has_plus AND v_prev1 = '-' AND pg_catalog.left(v_digits, 1) <> '0'
       AND (v_prev2 = '' OR v_prev2 !~* c_word_re) THEN
      CONTINUE;
    END IF;

    v_has_ctx_letters := v_line_before <> '' AND v_line_before ~* c_letter_re;
    IF v_has_ctx_letters THEN
      -- NFD -> ASCII lower -> D-stroke fold -> NFC makes Vietnamese labels (SĐT, ĐỒNG, VNĐ) locale-independent under C collation too.
      v_ctx_before := pg_catalog.normalize(pg_catalog.translate(pg_catalog.lower(pg_catalog.normalize(v_line_before, 'NFD')), pg_catalog.chr(272), pg_catalog.chr(273)), 'NFC');

      -- Reject meeting / room numbers when explicitly labelled (e.g. Zoom ID 842 1234 5678, cuộc họp số 912 3456 7890).
      IF NOT v_has_plus AND v_ctx_before ~ c_meeting_re THEN
        CONTINUE;
      END IF;

      v_tax_hint := v_ctx_before ~ c_tax_re;
      IF NOT v_tax_hint AND pg_catalog.strpos(v_line_before, 'TIN') > 0 THEN
        v_line_before_nfc := pg_catalog.normalize(v_line_before, 'NFC');
        v_tax_hint := v_line_before_nfc ~ c_tin_re AND v_ctx_before !~ c_tin_excl_re;
      END IF;
      v_id_hint := v_ctx_before ~ c_id_re;
      v_bank_hint := v_ctx_before ~ c_bank_re;
      v_phone_hint := v_ctx_before ~ c_phone_re;
    ELSE
      v_ctx_before := '';
      v_tax_hint := false;
      v_id_hint := false;
      v_bank_hint := false;
      v_phone_hint := false;
    END IF;

    -- Reject currency-tagged amounts (e.g. 100.000.000 đ, +100.000.000 đ, 50000000 VND, +50000000 VND, USD +12345678, $123456789).
    IF (NOT v_has_plus OR NOT v_phone_hint) AND (
      v_prev1 IN ('$', '€', '£', '¥', '₫')
      OR (v_has_ctx_letters AND NOT v_bank_hint AND NOT v_tax_hint AND v_ctx_before ~ c_curr_pre_re)
      OR (
        NOT (v_bank_hint OR v_tax_hint OR v_id_hint OR v_phone_hint)
        AND v_line_after <> ''
        AND pg_catalog.left(v_digits, 1) <> '0'
        AND pg_catalog.normalize(pg_catalog.translate(pg_catalog.lower(pg_catalog.normalize(v_line_after, 'NFD')), pg_catalog.chr(272), pg_catalog.chr(273)), 'NFC') ~ c_curr_suf_re
      )
    ) THEN
      CONTINUE;
    END IF;

    -- Reject dot-grouped thousands (+100.000.000, 100.000.000), decimal floats (+3.14159265, 1234567.89), and IPv4 dotted quads (192.168.1.100).
    v_has_dot := pg_catalog.strpos(v_match, '.') > 0;
    IF v_has_dot AND NOT (v_phone_hint OR v_bank_hint OR v_id_hint OR v_tax_hint) THEN
      v_abs_match := CASE WHEN pg_catalog.left(v_match, 1) = '+' THEN pg_catalog.substr(v_match, 2) ELSE v_match END;
      IF v_abs_match ~ c_dot_float_re
         OR (
           v_abs_match ~ c_dot_group_re
           AND NOT (v_has_plus AND v_vn_digits ~ '^84(?:[35789][0-9]{8}|2[0-9]{9})$' AND v_match !~ '\.000\.000$')
         ) THEN
        CONTINUE;
      END IF;
    END IF;

    -- Reject dates, year ranges, date+hour timestamps (01 02 2025 12, 2026-11-21 13), and unlabelled compact dates (20261121 unless v_bank_hint).
    IF NOT v_has_plus AND (
      (v_match_len <> v_digit_len AND v_match ~ c_date_delim_re)
      OR (NOT v_bank_hint AND v_digit_len = 8 AND v_digits ~ c_date_compact_re)
    ) THEN
      CONTINUE;
    END IF;

    -- Reject compact 14-digit YYYYMMDDHHmmSS timestamps unless explicitly labelled as bank/ID/tax.
    IF NOT v_has_plus AND NOT (v_bank_hint OR v_id_hint OR v_tax_hint)
       AND v_digit_len = 14 AND v_vn_digits ~ '^(?:19|20)[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])(?:[01][0-9]|2[0-3])[0-5][0-9][0-5][0-9]$' THEN
      CONTINUE;
    END IF;

    -- Reject round non-zero-prefixed amounts (e.g. 100000000, +100000000, 100 000 000) unless explicitly labelled or a valid +84 phone.
    IF pg_catalog.right(v_vn_digits, 4) = '0000'
       AND NOT (v_phone_hint OR v_bank_hint OR v_id_hint OR v_tax_hint)
       AND pg_catalog.left(v_vn_digits, 1) <> '0'
       AND NOT (v_has_plus AND v_vn_digits ~ '^84(?:[35789][0-9]{8}|2[0-9]{9})$' AND v_vn_digits !~ '000000$')
       AND (
         pg_catalog.right(v_vn_digits, 5) = '00000'
         OR pg_catalog.regexp_replace(v_match, '^\+', '') ~ ('^[1-9][0-9]{0,2}(?:[' || v_inline || '][0-9]{3}){2,}$')
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
    ELSIF v_digit_len = 10 AND v_match_len <> 10 AND v_match ~ c_nanp_re THEN
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
      WHILE v_ec_has AND v_ec_start < v_start LOOP
        kind := 'email';
        start_pos := v_ec_start;
        end_pos := v_ec_end;
        match_text := v_ec_match;
        RETURN NEXT;
        FETCH v_e_cur INTO v_ec_start, v_ec_end, v_ec_match;
        v_ec_has := FOUND;
      END LOOP;
      kind := v_kind;
      start_pos := v_start;
      end_pos := v_end;
      match_text := v_match;
      RETURN NEXT;
    END IF;
  END LOOP;

  WHILE v_ec_has LOOP
    kind := 'email';
    start_pos := v_ec_start;
    end_pos := v_ec_end;
    match_text := v_ec_match;
    RETURN NEXT;
    FETCH v_e_cur INTO v_ec_start, v_ec_end, v_ec_match;
    v_ec_has := FOUND;
  END LOOP;
  IF v_e_count > 0 THEN
    CLOSE v_e_cur;
  END IF;
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
  v_len integer;
  v_last_end integer;
  v_m_starts integer[];
  v_m_ends integer[];
  v_m_marks text[];
  v_out text;
  i integer;
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

  -- Re-detect on p_text once; keep only non-overlapping matches whose (start_pos, kind) matches a confirmed request.
  SELECT
    pg_catalog.array_agg(s.start_pos ORDER BY s.start_pos),
    pg_catalog.array_agg(s.end_pos ORDER BY s.start_pos),
    pg_catalog.array_agg(s.mark ORDER BY s.start_pos)
  INTO v_m_starts, v_m_ends, v_m_marks
  FROM (
    SELECT DISTINCT ON (td.start_pos) td.start_pos, td.end_pos, req.mark
    FROM crove_kernel.text_detect(p_text) AS td
    JOIN ROWS FROM (pg_catalog.unnest(p_starts), pg_catalog.unnest(p_kinds), pg_catalog.unnest(p_marks)) WITH ORDINALITY AS req(start_pos, kind, mark, ord)
      ON req.start_pos = td.start_pos AND req.kind = td.kind
    ORDER BY td.start_pos, req.ord
  ) AS s;

  IF v_m_starts IS NULL THEN
    RETURN p_text;
  END IF;

  v_len := pg_catalog.char_length(p_text);
  v_last_end := v_m_ends[pg_catalog.array_length(v_m_ends, 1)];

  -- Reconstruct linearly via 250-char chunks + hash join + single string_agg (never scanning full p_text per span).
  WITH bounds AS (
    SELECT
      m.ord::bigint AS span_ord,
      m.start_pos,
      m.end_pos,
      m.mark,
      COALESCE(pg_catalog.lag(m.end_pos) OVER (ORDER BY m.ord), 1) AS prev_end
    FROM ROWS FROM (
      pg_catalog.unnest(v_m_starts),
      pg_catalog.unnest(v_m_ends),
      pg_catalog.unnest(v_m_marks)
    ) WITH ORDINALITY AS m(start_pos, end_pos, mark, ord)
  ),
  gaps AS (
    SELECT span_ord, 0 AS sub_ord, prev_end AS g_from, start_pos AS g_to, NULL::text AS mark
    FROM bounds WHERE prev_end < start_pos
    UNION ALL
    SELECT span_ord, 1 AS sub_ord, start_pos AS g_from, end_pos AS g_to, mark
    FROM bounds
    UNION ALL
    SELECT
      (pg_catalog.array_length(v_m_starts, 1) + 1)::bigint AS span_ord,
      0 AS sub_ord,
      v_last_end AS g_from,
      v_len + 1 AS g_to,
      NULL::text AS mark
    WHERE v_last_end <= v_len
  ),
  chunks AS (
    SELECT n::integer AS c_idx, m[1] AS txt
    FROM pg_catalog.regexp_matches(p_text, '.{1,250}', 'g') WITH ORDINALITY AS t(m, n)
  ),
  pieces AS (
    SELECT g.span_ord, g.sub_ord, 0::integer AS c_idx, g.mark AS piece
    FROM gaps g
    WHERE g.mark IS NOT NULL
    UNION ALL
    SELECT
      g.span_ord,
      g.sub_ord,
      s.c_idx,
      pg_catalog.substr(
        c.txt,
        GREATEST(g.g_from, (s.c_idx - 1) * 250 + 1) - (s.c_idx - 1) * 250,
        LEAST(g.g_to, s.c_idx * 250 + 1) - GREATEST(g.g_from, (s.c_idx - 1) * 250 + 1)
      ) AS piece
    FROM gaps g
    CROSS JOIN LATERAL pg_catalog.generate_series((g.g_from - 1) / 250 + 1, (g.g_to - 2) / 250 + 1) AS s(c_idx)
    JOIN chunks c ON c.c_idx = s.c_idx
    WHERE g.mark IS NULL AND g.g_from < g.g_to
  )
  SELECT COALESCE(pg_catalog.string_agg(piece, '' ORDER BY span_ord, sub_ord, c_idx), '')
  INTO v_out
  FROM pieces;

  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.text_redact_spans(text, integer[], text[], text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.text_redact_spans(text, integer[], text[], text[]) TO crove_tenant;
