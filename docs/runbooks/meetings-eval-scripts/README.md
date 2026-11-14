# Scripts for the meeting transcription eval recordings

Six invented Vietnamese meetings that people read aloud and record, to make the eval set of the [meeting transcription eval](../meetings-transcribe-eval.md) (meetings plan step M11, issue #2585; plan section 15). The scripts are committed. **The recordings, the consents and the reference files never are**: GitHub is public.

Who does what: the owner (or the people the owner asks) records, with consent. An agent wrote the scripts. The lawyer questions of plan section 7 are separate and stay open on the issue.

## The six scripts

| Script | Recording name | Meeting | Speakers | Voice | Spoken words |
|---|---|---|---|---|---|
| [1](01-hop-ban-hang-tuan.md) | `hop-01` | Weekly sales meeting: deals, a debt, a discount, a promotion | 3 | northern | about 1,340 |
| [2](02-chot-so-ke-toan-cuoi-thang.md) | `hop-02` | Month-end close with the outside accountant: VAT, invoices, receivables | 3 | southern | about 1,480 |
| [3](03-tuyen-dung-nhan-vien-moi.md) | `hop-03` | Hiring and onboarding a new staff member: salary, trial, social insurance | 3 | northern | about 1,580 |
| [4](04-standup-san-pham.md) | `hop-04` | Product standup with English tech words: bug, hotfix, deploy, deadline | 4 | mixed | about 1,510 |
| [5](05-khach-hang-don-hang-tre.md) | `hop-05` | Call with a customer about a late order and a discount (chiết khấu) | 3 | northern and southern | about 1,460 |
| [6](06-dam-phan-gia-nha-cung-cap.md) | `hop-06` | Supplier price negotiation with interruptions and overlaps | 3 | southern and northern | about 1,470 |

- "Spoken words" counts Vietnamese syllables, which is how the eval counts words. A first take shows the real time: expect roughly 8 to 10 minutes each at a natural pace with the pauses between turns.
- Each script has clear decisions and action items with an owner and a due date. They are listed at the end of the file, under "Decisions and action items (not read aloud)", so the summary check of plan section 5.3 can use the same recordings.
- Every person, company, product and place name is invented, and there is no phone number, email, address, tax code or bank account anywhere. A name that matches a real person or business is chance. Do not swap in real names. The money, tax, insurance and date figures are made up for the reading, they are not advice, and a reader who knows a rule that differs should read the script as written.
- The scripts use northern and southern words on purpose (`vâng`, `ạ`, `nhé` against `dạ`, `nghen`, `hông`, `tui`). Readers read in their own accent: a southern reader can take a northern part. Keep the words as written.

## 1. Consent first

Voices are personal data, and plan section 7 says everyone whose voice is recorded must be told, that consent must be clear and freely given, that silence is not consent and that it can be withdrawn. Readers are people, even though the characters are invented. So, before anyone records:

1. Give each reader the consent text below and let them read it. They can say no, with no reason needed.
2. Keep one signed or typed consent per reader (the name, the date, the scripts they read) **outside the repository and in a different folder from the recordings**, for example `/srv/crove-transcribe-eval-consents/`. Never inside the eval folder: the eval refuses a `.txt` that has no recording next to it (see section 5).
3. Keep each consent with its recording for as long as the recording exists. Without a consent on file, a recording is deleted.
4. If a reader withdraws, delete their recordings and the references of those recordings, and tell the owner. Delete the eval's local diff folder (`TRANSCRIBE_EVAL_OUT`) too, since it holds transcript text.

Consent text, as a draft built from plan section 7 (the product's own sentence is "Mọi người trong cuộc họp đã được báo là cuộc họp được ghi âm"). The lawyer has not confirmed this wording; the owner confirms it before the first recording, and it changes if the lawyer's answers on the issue say so:

> Tôi đồng ý cho ghi âm giọng nói của tôi khi tôi đọc kịch bản họp mẫu (ghi rõ số kịch bản: ____).
>
> File ghi âm chỉ dùng để đo độ chính xác của chức năng chép lời cuộc họp của Ludy. File được cất ở nơi riêng của chủ dự án, không đưa vào kho mã nguồn và không đăng công khai. Khi chạy bài đo, file có thể được gửi tới nhà cung cấp dịch vụ chép lời mà Ludy dùng, và nhà cung cấp đó có thể đặt ở nước ngoài.
>
> Tôi đồng ý một cách tự nguyện. Nếu tôi không đồng ý thì cũng không sao. Tôi có thể rút lại sự đồng ý bất cứ lúc nào bằng cách nhắn cho người phụ trách; khi đó file ghi âm của tôi và bản chép tương ứng được xóa.
>
> Họ tên: ____  Ngày: ____  Chữ ký hoặc tin nhắn xác nhận: ____

Inside every script the first turn also says "this meeting is recorded", as a real host would (the product asks the recorder for the same notice, plan section 5.1). That line is part of the story. It is not the consent above, and it does not replace it.

Do not say a real name, phone number, address or any real personal detail in a take. If one slips out, record it again.

## 2. Set up the recording

- **Room:** a quiet room, doors closed, phones on silent, fans and air conditioning off. Everyone in one room around one recording device, like a real meeting, about an arm's length from it.
- **Devices:** use two kinds, as the product's users will: a **laptop microphone** (the in-app recorder, or any recorder app) and a **phone** laid on the table. A suggestion that makes both common cases part of the set: scripts 1, 2 and 3 on the laptop, scripts 4, 5 and 6 on the phone.
- **One noisy take:** also record one script again in a noisy place (a café, a street side, a room with a fan and a window open) to see how the provider copes. Suggestion: one noisy take each of scripts 1, 4 and 6. That makes up to nine files, inside the plan's "5 to 10".
- **Script 5 is a call.** Either read it in one room with the phone on the table, or, once the Ludy extension (M9) exists, as a real video call with each reader on their own device and the extension recording the tab. The second way also tests the capture path. Say which way you used in the file's name (below) or the notes.
- **Format:** any of `.ogg`, `.webm`, `.m4a`, `.mp3` (the eval accepts these). Do not convert the file if the recorder already made one of them. Each recording is one file for the whole script.
- **Names:** `hop-01.ogg` for the quiet take of script 1, `hop-01-noisy.ogg` for its noisy take, and so on. The reference has the same name with `.txt`.

## 3. How to read

- Read naturally, at your own pace, like a meeting, not a news bulletin. Do not stop to correct yourself unless you got a number or a name wrong. Do not read the speaker labels, the stage directions or the "Decisions and action items" section aloud.
- Small deviations are fine: a word added or dropped, a different filler like `à` or `ừ`, a different but equal word. After the take, fix the reference to match what was said (section 4). A big deviation (a missed paragraph, a number changed) means a new take. The goal is a reference that is exactly what the recording says, not a recording that is exactly the script.
- Say numbers in words as written. Say the English words as they are written (`deploy`, `bug`, `API`), in the way you say them in daily work.
- Act the stage directions that are sounds or actions only if it comes naturally (a pause, a laugh, putting a cup down). Do not read them. Interruptions and overlaps are meant to be acted, see below.

## 4. The script format and how to make the reference

Every script has the same parts: a header table, "Scene", "Script", and "Decisions and action items (not read aloud)". Only the part under `## Script` is read.

In that part:

- **A turn** is one line that starts with the speaker's name in square brackets: `[Thu] Chào hai bạn.` A speaker's label stays until the next label, the same as the eval's reference format.
- **A stage direction on its own line** starts with `>` and is in parentheses: `> (Tuấn đi ra khỏi chỗ ngồi)`. It is never spoken and never in the reference.
- **A mark inside a turn** is in curly braces: `[Bách] {chen lời} Em hiểu chứ...`. It says how the words are said (cutting in, speaking at the same time, going on after a cut). It is never spoken and never in the reference.
- **An interruption:** the turn that is cut ends with `...` and the next turn starts with the interrupter, often with `{chen lời}`. The cut speaker may go on in a later turn that starts with `...` and `{nói tiếp}`. Actually cut each other off at that point, as in a real meeting.
- **An overlap:** two turns in a row marked `{nói cùng lúc}`: both speakers talk at the same moment, for a second or two. The reference lists the words in the order the turns are written.
- **The read-aloud text has no digit.** Amounts, percentages, dates and counts are written in words, as they are said. This is deliberate. Providers often answer with digits, and the eval does not equate `hai mươi lăm` with `25`, so those show as errors; that is a real finding, not a reason to change the reference. Report it with the numbers.
- **Tone marks** use the modern spelling (`hòa`, `thủy`), as the eval runbook asks you to match the provider's style. If the provider writes the old style (`hoà`), expect substitutions on those words, or change the reference once for the whole set.

Make the reference with these commands. Run them in the folder of the scripts, and write the output **outside the repository**, next to the recording:

```sh
# With speaker labels, so the eval can score the speakers (recommended):
awk '/^## Script/{on=1;next} /^## /{on=0} on' 01-hop-ban-hang-tuan.md \
  | grep -v '^>' | sed -e 's/{[^}]*}//g' -e 's/  */ /g' -e '/^[[:space:]]*$/d' \
  > /srv/crove-transcribe-eval/hop-01.txt

# Words only, no labels (the eval then scores words only):
awk '/^## Script/{on=1;next} /^## /{on=0} on' 01-hop-ban-hang-tuan.md \
  | grep -v '^>' | sed -e 's/{[^}]*}//g' -e 's/^\[[^]]*\] *//' -e 's/  */ /g' -e '/^[[:space:]]*$/d' \
  > /srv/crove-transcribe-eval/hop-01.txt
```

For a noisy take, copy the same reference to the noisy name (`hop-01-noisy.txt`). Then open the file, listen to the recording and change it to match what was said. Use the names of the characters as labels, as written in the script, and keep the same set of names for each take of one script. A file that was edited must be read once more from the top against the audio before it is used: a wrong reference makes a good provider look bad.

## 5. Where the files go

As in step 1 of the [eval runbook](../meetings-transcribe-eval.md#1-where-the-recordings-go): one folder outside your checkout of this repository, for example `/srv/crove-transcribe-eval/`, with each recording and its reference side by side:

```
/srv/crove-transcribe-eval/
  hop-01.ogg        hop-01.txt
  hop-01-noisy.ogg  hop-01-noisy.txt
  hop-02.m4a        hop-02.txt
  ...
/srv/crove-transcribe-eval-consents/    (a different folder, never inside the one above)
  one consent per reader
```

The eval stops at the start when a recording has no reference, or a reference has no recording, and names the file. So the consents must not sit beside the recordings as `.txt` files, and a reference must never be left over after its recording is deleted.

## 6. Never commit

Never add to a commit, a pull request, an issue, a comment or a CI log: a recording, a reference made for a recording (the scripts are the committed form, and a reference with edits is a transcript of a real voice), a consent, a reader's name next to a script number, the eval's local diff folder, or a pasted transcript line. The eval's own report prints no transcript text and no file name, so its numbers can be pasted into issue #2585. Run with `TRANSCRIBE_EVAL_SHOW_PAIRS=true` only on your own screen.

The repository's PII scan and the docs check run on every pull request; they are a safety net and do not replace this list.

## What comes out of it

With the recordings in place, the owner runs `pnpm ai:eval:transcribe` on a private machine (the [runbook](../meetings-transcribe-eval.md) section 2), gets the first real WER and speaker numbers, and confirms or changes the proposed pass line of 15 percent WER on clear speech. The two or three noisy takes show how far the provider falls on bad audio. The numbers go on issue #2585. The recordings and the consents stay with the owner.
