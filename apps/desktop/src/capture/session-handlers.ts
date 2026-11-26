// SPDX-License-Identifier: AGPL-3.0-only
// Electron session permission & fallback display-media handlers for Ludy Desktop capture (isolated under src/capture/).
import { desktopCapturer, systemPreferences, webContents as electronWebContents, type Session } from 'electron';
import { isExpectedUiOrigin } from './ui-bundle.ts';

export async function requestMacMicrophoneAccess(): Promise<boolean> {
  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'granted') return true;
  if (status === 'not-determined') return systemPreferences.askForMediaAccess('microphone');
  return false;
}

export function installCaptureSessionHandlers(
  ses: Session,
  captureOrigin: string,
  state: { getActiveWorkerId: () => number | null; consumeSystemFallbackArmed: () => boolean },
): void {
  const isCaptureWorker = (webContentsId: number | null | undefined, origin: string | undefined, isMainFrame: boolean): boolean => {
    const activeId = state.getActiveWorkerId();
    return isMainFrame && activeId !== null && webContentsId === activeId && isExpectedUiOrigin(origin, captureOrigin);
  };

  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (permission !== 'media' && permission !== 'display-capture') return false;
    const origin = details?.securityOrigin ?? details?.requestingUrl ?? requestingOrigin;
    return isCaptureWorker(webContents?.id, origin, details?.isMainFrame === true);
  });

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission !== 'media' && permission !== 'display-capture') return callback(false);
    const secOrigin = details && 'securityOrigin' in details ? details.securityOrigin : undefined;
    const origin = secOrigin ?? details?.requestingUrl ?? webContents?.getURL();
    callback(isCaptureWorker(webContents?.id, origin, details?.isMainFrame === true));
  });

  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    const frame = request.frame;
    const frameWc = frame ? electronWebContents.fromFrame(frame) : null;
    const isMainFrame = Boolean(frame && frame.parent === null && frameWc?.mainFrame === frame);
    if (!isCaptureWorker(frameWc?.id, request.securityOrigin, isMainFrame) || !state.consumeSystemFallbackArmed()) {
      return callback({});
    }
    const sources = await desktopCapturer.getSources({ types: ['screen'] }).catch(() => []);
    const primary = sources[0];
    if (!primary) return callback({});
    callback({ video: primary, audio: 'loopback' });
  });
}
