# Native reader's check of a translation language (Chinese, Japanese, Korean)

Meetings step E3 ([#3186](https://github.com/DOS/Ludy/issues/3186)). The code ships the three languages switched off. A language goes into `MEETINGS_TRANSLATION_LANGUAGES` only after a person who reads it natively has checked what the model writes and the verdict is on the issue. This page is that check, step by step. Nothing here is automatic: the reader is an owner action (a pilot's or a partner's staff), which the Meetings PO routes.

## What is checked and why a person does it

The research found no measure of any language pair, and code can only test shape: the figures are the source's figures, there is no link or address the source does not have, the text is in the language's script, it is not longer than the original allows, and every foreign Latin name or acronym of the source stands in it as written (one that was transliterated or dropped shows the mark "a name may differ from the original"; Vietnamese words, places and titles are not asked for, so the reader also looks for names the mark did not catch). Code cannot tell that a sentence reads as a native would write it, that a business register is right, or that the meaning is not turned around. The reader says that.

## Who and what you need

- **A native reader** of the language, who also reads Vietnamese well enough to compare. One reader per language; a second opinion is better when it can be had. The reader is not told what the model is; they judge the text.
- **A test deployment, never the pilot.** `MEETINGS_SUMMARY=on`, a model on the AI budget meter (the cost of this check is small and shows in the meter), and `MEETINGS_TRANSLATION_LANGUAGES` set to only the language under check.
- **Invented meetings only.** Use the six scripted meetings of [meetings-eval-scripts](meetings-eval-scripts/README.md). Their people, companies and figures are invented. Never a real customer's meeting: the text goes to the deployment's model provider.

## Steps (about an hour per language)

1. On the test deployment, make a meeting from each of two scripts (one with figures and an owner and a due date, for example `01-hop-ban-hang-tuan.md` and `02-chot-so-ke-toan-cuoi-thang.md`, plus `04-standup-san-pham.md` for the English tech words): get the script into a meeting as its transcript (read it aloud and upload the recording, after the consent step of [the scripts' README](meetings-eval-scripts/README.md#1-consent-first), or use a platform recording of the sandbox provider that carries the script as its transcript), write the summary and the decisions from the script's own "Decisions and action items" section, publish the result.
2. As the recorder, open the meeting, pick the language in "Dịch sang" on the summary card and click. Do the same on the transcript panel for the first lines, enough for about 20 lines in all, picked so that some hold a figure, some a name or an acronym, some an English word, and some are short ("Dạ", "Vâng").
3. Give the reader the original and the translation side by side (a screenshot or a copy of the two columns), with the marks the screen showed (a mark is code's warning, not a verdict).
4. The reader rates every line and the summary with the scale below and writes one sentence for any line below "acceptable".
5. Run the same lines once more through the same language to see whether the answer is stable (the model may differ between two clicks; a reader who sees two very different quality levels says so).
6. Post the verdict on [#3186](https://github.com/DOS/Ludy/issues/3186) in the form below. The Meetings PO decides, with the owner, whether the language goes into the list. Nobody turns a language on without a posted verdict.

## The scale

| Rating | Means |
|---|---|
| 3, good | A native would write it this way; meaning, figures and names right |
| 2, acceptable | Understandable and correct, a little stiff or unnatural; no one would be misled |
| 1, poor | Wrong or odd wording that could mislead, or a figure, name or date wrong |
| 0, wrong | Meaning reversed, something invented or dropped that matters, or not the language |

Proposed bar to switch a language on (the Meetings PO and the owner confirm or change it): at least 18 of 20 lines rated 2 or 3, no line rated 0, no figure or name wrong in any line, and the summary rated 2 or 3. A line rated 1 is listed with its reason.

## The verdict, as a comment on the issue

```
Language: zh | ja | ko
Reader: first name or role only (no personal details), native language, how they read Vietnamese
Date, deployment (test), model name from the meter
Lines read: N (summary: yes/no)  Ratings: 3 x __, 2 x __, 1 x __, 0 x __
Figures and names kept: yes/no, with the lines where not
Marks (name may differ, figure dropped): shown when they should be? any missing or wrong?
Register: right for a business meeting? (polite forms for ja and ko, simplified characters for zh)
Stable between two clicks: yes/no
Lines rated 1 or 0, with the reader's sentence
Verdict: switch on / switch on with a known limit (say which) / not yet (say why)
```

## When the verdict is "not yet"

Say what is wrong. If it is a pattern code can catch (a figure written as a number word, a name always transliterated), that is a follow-up issue for the checks, and the language stays off. If it is the model's quality, the language stays off until a different model or prompt is tried and read again; the length bound (1.5 characters per original character, plus 60) and the other limits in `packages/agent/src/member-vy/meeting-translation.ts` are tuned from these readings, not before.
