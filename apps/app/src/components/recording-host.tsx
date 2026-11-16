// SPDX-License-Identifier: AGPL-3.0-only
// Gives the app-level recorder (lib/recording-controller.ts, #3197) what it needs from React while it records across screens:
// the member's language for what it says, and the router to open a finished meeting. Renders nothing; mounted once in the org layout.
import { useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useTranslations } from 'use-intl';
import { setRecorderNavigator, setRecorderTranslator } from '../lib/recording-controller.ts';

export function RecordingHost() {
  const t = useTranslations('meetings');
  const navigate = useNavigate();
  useEffect(() => {
    setRecorderTranslator((key, params) => t(key as never, params as never));
    setRecorderNavigator((slug, id) => void navigate({ to: '/o/$slug/meetings/$id', params: { slug, id } }));
  }, [t, navigate]);
  return null;
}
