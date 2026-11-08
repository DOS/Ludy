// SPDX-License-Identifier: AGPL-3.0-only
// An offscreen document cannot show the browser's microphone prompt, so the member answers it once on this page, opened
// by the member's own click when they turn meeting capture on. It records nothing: the stream is stopped at once.
const status = document.getElementById('status');
navigator.mediaDevices
  .getUserMedia({ audio: true })
  .then((stream) => {
    for (const track of stream.getTracks()) track.stop();
    if (status) status.textContent = 'Xong. Bạn có thể đóng tab này.';
  })
  .catch(() => {
    if (status) status.textContent = 'Micro chưa được cho phép. Ludy vẫn ghi âm thanh của tab họp, nhưng không có giọng của bạn. Bạn có thể cho phép micro trong cài đặt trình duyệt.';
  });
