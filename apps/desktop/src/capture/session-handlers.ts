// SPDX-License-Identifier: AGPL-3.0-only
// Electron session permission & fallback display-media handlers for Ludy Desktop capture (isolated under src/capture/).
import { desktopCapturer, webContents as electronWebContents, type Session } from 'electron';

export function installCaptureSessionHandlers(
  ses: Session,
  captureOrigin: string,
  state: { getActiveWorkerId: () => number | null; consumeSystemFallbackArmed: () => boolean },
): void {
  const isCaptureWorker = (webContentsId: number | null | undefined, origin: string | undefined): boolean => {
    const activeId = state.getActiveWorkerId();
    return activeId !== null && webContentsId === activeId && (origin ?? '').startsWith(captureOrigin);
  };

  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    if (permission !== 'media' && permission !== 'display-capture') return false;
    return isCaptureWorker(webContents?.id, requestingOrigin);
  });

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission !== 'media' && permission !== 'display-capture') return callback(false);
    callback(isCaptureWorker(webContents?.id, details?.requestingUrl ?? webContents?.getURL()));
  });

  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    const frameWc = request.frame ? electronWebContents.fromFrame(request.frame) : null;
    if (!isCaptureWorker(frameWc?.id, request.securityOrigin) || !state.consumeSystemFallbackArmed()) {
      return callback({});
    }
    const sources = await desktopCapturer.getSources({ types: ['screen'] }).catch(() => []);
    const primary = sources[0];
    if (!primary) return callback({});
    callback({ video: primary, audio: 'loopback' });
  });
}
