// SPDX-License-Identifier: AGPL-3.0-only
// Gives the app-level recorder (lib/recording-controller.ts, #3197) what it needs from React while it records across screens:
// the member's language for what it says, and the router to open a finished meeting. It also ends a recording that belongs to
// another org than the one now open (an org switch saves it like the Stop button does). Renders nothing; mounted once at the
// root, so every screen has it, whether or not it is inside an org.
import { useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useSyncExternalStore } from 'react';
import { useTranslations } from 'use-intl';
import { getRecorderSnapshot, recordingLeftItsOrg, setRecorderNavigator, setRecorderTranslator, stopAndSave, subscribeRecorder } from '../lib/recording-controller.ts';

export function RecordingHost() {
  const t = useTranslations('meetings');
  const navigate = useNavigate();
  const { slug } = useParams({ strict: false }) as { slug?: string };
  const recorder = useSyncExternalStore(subscribeRecorder, getRecorderSnapshot, getRecorderSnapshot);
  useEffect(() => {
    setRecorderTranslator((key, params) => t(key as never, params as never));
    setRecorderNavigator((orgSlug, id) => void navigate({ to: '/o/$slug/meetings/$id', params: { slug: orgSlug, id } }));
  }, [t, navigate]);
  // The recording belongs to the org it was made in (its device copy is scoped to it, and so is the upload): another org open means it ends.
  useEffect(() => {
    if (recordingLeftItsOrg(slug, recorder)) void stopAndSave();
  }, [slug, recorder.slug, recorder.phase]);
  return null;
}
