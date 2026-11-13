// SPDX-License-Identifier: AGPL-3.0-only
// An offscreen document cannot show the browser's microphone prompt, so the member answers it once on this page, opened
// by the member's own click when they turn meeting capture on. It records nothing: the stream is stopped at once.
// Its words come from strings.ts, like the popup's (English for an English browser, Vietnamese otherwise).
import { T } from './strings.ts';

const status = document.getElementById('status');
document.title = T.micTitle;
const heading = document.getElementById('heading');
if (heading) heading.textContent = T.micHeading;
if (status) status.textContent = T.micPrompt;
navigator.mediaDevices
  .getUserMedia({ audio: true })
  .then((stream) => {
    for (const track of stream.getTracks()) track.stop();
    if (status) status.textContent = T.micDone;
  })
  .catch(() => {
    if (status) status.textContent = T.micDenied;
  });
