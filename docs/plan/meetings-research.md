# Meetings research: other meeting-notes products and integration routes (2026-11-14)

Research notes behind the Meetings integrations plan, asked by the owner on 2026-11-14. Vietnamese report for the owner: [meetings-research.vi.md](meetings-research.vi.md).

**Caveat:** this session could not open any vendor page (the network allowlist blocked them); every finding comes from search-result summaries of the cited pages, and every price is unverified. Each build issue re-checks its facts on the vendor page first.


## Notes: incumbents


Method note (read first): research run on 2026-11-14. WebFetch could not reach any vendor or law-firm page from this session (DNS blocked for support.google.com, circleback.ai, bairdholm.com and others), so every finding below comes from web-search result summaries, not full-page reads. Most pricing figures come from third-party comparison blogs (often written by competitors) that disagree with each other; vendor pricing pages were not read directly. Treat every price as approximate and every unconfirmed item as flagged. Items marked "[prior knowledge, unverified]" are from background knowledge and were not confirmed in this session.

### 1. How each product captures meetings, and how it handles notice and consent

#### Takeaway
Two capture models dominate: third-party "bot joins the call" products (Otter, Fireflies, Fathom, Read.ai, tl;dv) that auto-join from the connected calendar, and platform-native or device-audio capture (Zoom, Google Meet, Teams, Notion desktop) with no visible bot. Consent is the industry's weak point: auto-join plus consent taken only from the account holder is the exact fact pattern behind the 2025-2026 lawsuits against Otter and Fireflies, and Google answered in 2026 with an admin-enforced "explicit consent" gate.

#### Cited Findings
**Bot-join, calendar-driven products**
- Read AI: "By default, Read will join all meetings on your calendar"; Otter automatically joins scheduled events once a calendar is connected , [tl;dv blog, AI meeting recorder lawsuits 2026](https://tldv.io/blog/ai-meeting-recorder-lawsuits/) (competitor source)
- Otter's follow-up emails reportedly contain partial transcripts and screenshots and go to all meeting invitees, including people who never attended; both Otter and Read ask recipients without an account to sign up to read them (growth loop) , [tl;dv blog](https://tldv.io/blog/ai-meeting-recorder-lawsuits/); [Synk, "Notetakers spread like viruses"](https://synk.to/blog/detect-and-stop-ai-notetakers)
- Notetakers spread "through meetings, not purchases"; bots are identifiable by default names like "Fireflies.ai Notetaker", though customers can rename them , [Synk](https://synk.to/blog/detect-and-stop-ai-notetakers) (vendor of a bot-blocking tool)
- Zoom AI Companion can record Meet, Teams or Slack calls only via a paid add-on (+$12/month per one source) that "joins as a visible bot" , [itsconvo Zoom pricing 2026](https://www.itsconvo.com/pricing/zoom) (third-party, unverified)

**Native / device-audio capture**
- Zoom AI Companion only works in Zoom meetings natively , [itsconvo](https://www.itsconvo.com/pricing/zoom)
- Notion AI Meeting Notes: the desktop app records microphone plus system audio, capturing everyone on a call without a bot; in a browser, on mobile, it transcribes the mic only (so with headphones, other participants are missed) , [Scribbl, Notion AI Meeting Notes 2026](https://scribbl.co/post/notion-ai-meeting-notes); [tl;dv Notion review 2026](https://tldv.io/blog/notion-ai-meeting-notes-review/)
- Google Meet "Take notes for me" extended to in-person meetings with no video call: Android from 11 Aug 2026, web 14 Aug 2026, iOS no earlier than 31 Aug 2026; participants are alerted when a session starts; an admin who disabled the feature also disables it in person , [pasqualepillitteri.it, Aug 2026](https://pasqualepillitteri.it/en/news/11419/google-meet-take-notes-in-person-meetings) (secondary)
- Each Meet participant's screen shows a pencil icon once Gemini notes start (secondhand) , [notemeeting.com](https://notemeeting.com/en/blog/gemini-zoom)
- Conflict: one source says since Aug 2026 you can start Gemini notes from the Meet home screen during a Zoom call (device mic only) , [notemeeting.com](https://notemeeting.com/en/blog/gemini-zoom); another says there is no native flow for Zoom or Teams , [anarlog.so, 2026](https://anarlog.so/blog/google-gemini-meeting-notes/)
- Gemini notes are available to Google AI Pro and Ultra consumer subscribers too, "in select languages" , [Google blog, Take notes for me](https://blog.google/products-and-platforms/products/workspace/take-notes-for-me/) (search snippet; date shown as 29 June 2026 by one result, unverified)

**Consent controls (platform-native)**
- Google Workspace (primary source): admins can require explicit consent from participants before automatic note-taking, recording or transcription starts in Meet; setting is OFF by default, set at domain, OU or group level, no end-user toggle; rollout began 5 May 2026 , [Google Workspace Updates, April 2026](https://workspaceupdates.googleblog.com/2026/04/require-explicit-consent-for-take-notes-with-Gemini-recordings-and-transcripts-in-Google-Meet.html)
- A notification does not replace legal or company consent requirements; consent rules vary by country and US state , [anarlog.so](https://anarlog.so/blog/google-gemini-meeting-notes/); [notemeeting.com](https://notemeeting.com/en/blog/gemini-zoom)

#### Inferences
- Ludy Meetings' design (tab capture by extension, in-app mic, upload, no bot) matches the "bot-free" direction the market is moving to (Notion desktop, Granola, Gemini in-person). The lawsuits show the bot model's legal risk is concentrated in auto-join and non-user participants.
- Google's explicit-consent gate is the closest primary-source pattern for Ludy's consent record: a per-meeting consent step that an org setting can make mandatory, not just a notice.
- Ludy should never auto-email summaries to all invitees or gate them behind sign-up; that growth loop is the most cited complaint and a lawsuit allegation.

#### Gaps
- Microsoft Teams' recording/transcription notice banner and consent flow for Copilot without recording were not researched in this session (search returned licensing only). [prior knowledge, unverified: Teams shows a "recording/transcription started" banner and Copilot can run "during the meeting only" without saving a transcript.]
- Fathom and tl;dv consent behavior (e.g., chat message on join, opt-out links) not confirmed.

### 2. Standout features

#### Takeaway
Feature parity is high on transcripts, summaries and action items; differentiation sits in (a) "ask across all meetings" chat (Fireflies AskFred, Read Search Copilot, Ask Fathom), (b) CRM field sync gated to top tiers (Fathom Business, Fireflies), (c) clips and highlights (Fathom, tl;dv), (d) coaching and talk-time analytics (Fireflies, Read), and (e) bundling with a suite (Zoom, Google, Microsoft, Notion). Vietnamese is explicitly listed only by Fireflies among the checked products; no source measured Vietnamese accuracy.

#### Cited Findings
**Ask across meetings**
- Fireflies AskFred searches across all meetings and cites/links to the passage; reviewers call it among the best assistants tested; each question uses AI credits and pauses at the cap; one review warns of documented auto-enrollment into AI credit purchases , [skillscouter Fireflies review 2026](https://skillscouter.com/fireflies-review/); [tl;dv Fireflies review](https://tldv.io/blog/fireflies-review/); [wave.co](https://wave.co/compare/fireflies-ai-review)
- Read.ai free plan includes "unlimited enterprise search across meetings, email and messages", while Search Copilot's direct access to Claude and GPT models starts on paid plans , [layer3labs Read AI pricing](https://www.layer3labs.io/guides/read-ai-pricing); [scribbl Read AI pricing](https://scribbl.co/post/read-ai-pricing)
- Ask Fathom: conflicting reports whether it is on the free plan (one says not included on Free; another says limited to the first five calls a month) , [claap Fathom pricing](https://www.claap.io/blog/fathom-pricing); [scribbl Fathom pricing](https://scribbl.co/post/fathom-pricing)

**CRM sync and task push**
- Fathom: CRM sync to HubSpot, Salesforce and Close included for up to 3 users on one email domain on Free, Premium and Team; field-level sync, Deal View and coaching metrics on Business , [weflow Fathom pricing for sales teams](https://www.weflow.ai/blog/fathom-pricing-for-sales-teams); [castan Fathom pricing](https://castan.ai/blog/fathom-pricing)
- Fireflies: Salesforce and HubSpot sync (conflict on whether Pro or Business); connects to Slack, Notion, Asana and CRMs; one review says CRM sync needs more manual setup than Fathom , [onyxranked 2026](https://onyxranked.com/fireflies-ai-review-2026/); [aiwisepicks](https://aiwisepicks.com/ai-meeting/fireflies-ai-review/)
- Zoom AI Companion 3.0 (launched Dec 2025) is positioned around "agentic workflows, transforming conversations into action" , [Zoom newsroom](https://news.zoom.com/zoom-launches-ai-companion-3-0/)
- Teams intelligent recap includes AI notes and suggested tasks (with Teams Premium or a Copilot license) , [Scribbl, Teams Premium features 2026](https://scribbl.co/post/teams-premium-features)

**Coaching / analytics**
- Fireflies higher tiers: talk-to-listen ratio, sentiment, monologue length, custom topic trackers , [skillscouter](https://skillscouter.com/fireflies-review/); [revops.tools](https://revops.tools/fireflies-ai/)

**Clips / highlights / library**
- Fathom Free includes clips, playlists and search alongside unlimited recordings , [scribbl Fathom pricing](https://scribbl.co/post/fathom-pricing)
- Team plans (Fathom Team) add shared libraries and collaboration , [claap](https://www.claap.io/blog/fathom-pricing)

**Multilingual and Vietnamese**
- Fireflies (primary help center): 100+ languages for transcription and summaries, Vietnamese listed (code "vi"); Multi-Language Mode (beta) handles speakers switching language within one meeting, 60+ languages including Vietnamese , [Fireflies supported languages](https://guide.fireflies.ai/articles/2973706448-learn-about-fireflies-supported-languages); [Fireflies Multi-Language Mode](https://guide.fireflies.ai/articles/2585231364-transcribe-fireflies-meetings-in-multiple-languages-with-multi-language-mode-beta)
- Conflict: a 2026 review says Fireflies' pricing FAQ calls English primary, with Spanish, French, Portuguese, Italian supported and the rest beta , [meetergo](https://meetergo.com/en/magazine/fireflies-reviews); one review says accuracy drops to 75-85% for major European languages , [aitoolbox.hk](https://www.aitoolbox.hk/articles/best-ai-transcription-tools-2026-fireflies-vs-otter-vs-krisp-vs-fathom-vs-tldv)
- Otter supports about six languages per a competitor (Fireflies) claim; not confirmed from Otter , [Fireflies blog](https://fireflies.ai/blog/fireflies-multi-language-transcription)
- Fathom: 28 or 38 languages depending on source; tl;dv 30+ or 40+; Read.ai auto-detects languages, one table says 12 , none confirm Vietnamese , [tl;dv Fathom alternatives](https://tldv.io/blog/fathom-ai-notetaker-review-alternatives/); [thebusinessdive](https://thebusinessdive.com/fathom-vs-tldv); [tl;dv Read AI review, Nov 2026](https://tldv.io/blog/read-ai-review-alternatives/)
- Google Meet "Take notes for me": several guides list 8 languages (English, French, German, Italian, Japanese, Korean, Portuguese, Spanish) without Vietnamese, and one language per meeting , [MeetGeek](https://meetgeek.ai/blog/google-meet-ai); [HappyScribe](https://www.happyscribe.com/blog/take-notes-in-google-meet-meetings); Google's own language page appears to list Vietnamese under "Take notes for me" but the snippet was garbled and could not be fetched , [Google Meet Help, supported languages](https://support.google.com/meet/answer/14925782?hl=en) (UNVERIFIED)
- Notion AI Meeting Notes: 16 languages; speaker labels English-only per several reviews , [Scribbl Notion](https://scribbl.co/post/notion-ai-meeting-notes); [sally.io](https://www.sally.io/blog/notion-ai-meeting-notes-review)
- Microsoft Teams: language counts conflict (16+, or 30+ with 9 auto-detect); one early-2026 source says Copilot works best in English with lower accuracy for summaries and action items in other languages , [meetgeek Teams](https://meetgeek.ai/blog/best-ai-note-taker-microsoft-teams); [getvoibe Teams](https://www.getvoibe.com/resources/best-ai-note-taker-for-microsoft-teams/)

#### Inferences
- The "ask across meetings" pattern with citations back to the transcript passage is the most praised feature; Ludy's search across meetings should answer with linked quotes, not only keyword hits.
- CRM field sync is the main paywall lever for sales-focused notetakers; Ludy has CRM in the same product, so writing approved meeting outcomes into deals/contacts as drafts is a natural advantage, not an upsell.
- Vietnamese is at best a long-tail "beta" language for incumbents; Vietnamese quality (diacritics, code-switching with English, speaker labels) is a credible differentiator, but no incumbent benchmark exists to compare against.
- Credit-metered AI chat (Fireflies) draws complaints; Ludy's AI budget meter should show cost before the user hits a wall and never auto-buy.

#### Gaps
- No source measured Vietnamese accuracy for any product. Zoom AI Companion and Teams Copilot Vietnamese support could not be confirmed.
- Templates per meeting type: not covered by search results. [prior knowledge, unverified: Fathom, tl;dv, Fireflies and Otter offer summary templates per meeting type (sales, 1:1, standup); tl;dv and Fathom offer sales frameworks such as BANT/MEDDIC.]
- Live notes during the meeting: not covered. [prior knowledge, unverified: Otter shows live transcript and lets users add highlights and ask Otter during the call; Teams Copilot answers questions live; Notion lets the user type notes that merge with the AI summary.]
- Pipedrive integrations: no results.
- Read.ai coaching (engagement, sentiment, speaker coach) not confirmed this session.

### 3. Pricing for a solo user and a 5-10 person team (2026)

#### Takeaway
Solo users can get a lot free (Fathom unlimited recordings; Otter 300 min/month at 30 min per meeting; Read 5 meetings/month). Paid seats for third-party notetakers cluster at about $8-$20 per user per month annual for individual tiers and $15-$30 for team/business tiers, so a 5-10 person team pays roughly $75-$300 per month. Platform-native assistants are "free" only inside an existing paid suite: Zoom bundles AI Companion with paid plans; Teams needs Premium ($10) or Copilot ($18-$30); Notion needs the Business plan ($20).

#### Cited Findings
| Product | Free tier | Solo paid | Team | Source |
|---|---|---|---|---|
| Otter.ai | Basic: 300 min/month, 30 min per conversation, 3 lifetime file imports | Pro: $16.99/user monthly or $8.33 annual; 1,200 min/month, 90 min cap | Business: $30 monthly or $19.99 annual; most say unlimited meeting minutes, 4 h cap; one source says 5-seat minimum | [claap Otter pricing](https://www.claap.io/blog/otter-pricing); [layer3labs](https://www.layer3labs.io/guides/otter-ai-pricing); [candor](https://candor.inc/blog/otter-ai-pricing) |
| Fireflies | (free tier not detailed in results) | Pro $10 annual / $18 monthly; storage 8,000 min per seat on Pro | Business $19 / $29; Enterprise $39 | [Circleback comparison, Oct 2026](https://circleback.ai/blog/ai-meeting-notetaker-pricing-compared) (competitor); [castan](https://castan.ai/blog/ai-meeting-notetaker-cost) |
| Fathom | Unlimited recordings, transcription, storage; 5 advanced AI summaries a month | Premium $16 annual / $20 monthly | Team $15, Business $25 per user annual; free seats no longer available on Team/Business | [scribbl Fathom](https://scribbl.co/post/fathom-pricing); [claap](https://www.claap.io/blog/fathom-pricing); [castan Fathom](https://castan.ai/blog/fathom-pricing) |
| Read.ai | 5 meetings/month, 1 h cap | Pro $15 annual / $19.75 monthly (conflicting: $29.75 also cited) | Enterprise tiers up to about $39.75 | [layer3labs Read](https://www.layer3labs.io/guides/read-ai-pricing); [costbench](https://costbench.com/software/ai-meeting-assistants/read-ai/) |
| tl;dv | Unlimited recordings and transcripts, AI notes for 10 meetings/month | Pro $18/user/month | Business $29 or $59 (conflict) | [Circleback](https://circleback.ai/blog/ai-meeting-notetaker-pricing-compared); [usecarly](https://www.usecarly.com/blog/otter-vs-fireflies-vs-fathom/) |
| Zoom AI Companion | Basic (free Zoom) gets select features to try, about 3 meetings/month per independent reporting | Included with Pro ($13.33 annual / $16.99 monthly); standalone AI Companion $10/month without a paid Zoom license | Business $18.33/user annual; Custom AI Companion and cross-platform recording are add-ons | [Zoom newsroom, AI Companion 3.0](https://news.zoom.com/zoom-launches-ai-companion-3-0/); [itsconvo Zoom](https://www.itsconvo.com/pricing/zoom) |
| Google Meet Gemini | n/a | Google AI Pro / Ultra consumer subscriptions include it | Included in Workspace plans with Gemini (exact tier prices not confirmed) | [Google blog](https://blog.google/products-and-platforms/products/workspace/take-notes-for-me/) |
| Teams Copilot / Intelligent Recap | Basic Teams: no intelligent recap | n/a | Teams Premium $10/user/month annual; Copilot Business $18 (first-year promo to 31 Dec 2026, regular $21); Microsoft 365 Copilot $30 | [Scribbl Teams Premium](https://scribbl.co/post/teams-premium-features); [super-intern](https://super-intern.com/en/blog/2026-teams-meeting-summary-ai) |
| Notion AI Meeting Notes | Free/Plus: limited trial only | n/a | Business plan $20/member annual, $24 monthly; no separate meeting-notes charge (as of Oct 2026) | [Scribbl Notion](https://scribbl.co/post/notion-ai-meeting-notes); [lifestack](https://lifestack.ai/blog/notion-pricing) |

- Conflict: one source claims Zoom retired the "AI Companion" brand on 1 June 2026 in favor of a free "Zoom AI" and paid "ZoomMate" from $20/user/month; no other source repeats it , UNVERIFIED, cited via [itsconvo / search summary](https://www.itsconvo.com/pricing/zoom)
- Conflict: one source claims Otter cut Pro from 6,000 to 1,200 minutes; another found no dated record of the change , [wave.co](https://wave.co/compare/otter-ai-pricing); [dynalord](https://dynalord.com/blog/otter-pricing)
- Otter offered a temporary promo of $24 instead of $30/month for 3 months to first-time Business subscribers , [felloai](https://felloai.com/otter-ai-pricing/)

#### Inferences
- For a Vietnamese 5-person SME: Fathom Team about $75/month, Otter Business about $100/month, Fireflies Business about $95/month (annual). In VND this is roughly 2-2.6 million VND per month for a 5-seat team, a meaningful cost for an SME; a self-hosted module bundled in a business OS undercuts this by design.
- Minute caps and per-meeting length caps (Otter 30 min free, Read 1 h free) are the main frustration lever in free tiers.

#### Gaps
- Vendor pricing pages could not be fetched; all prices are third-party. Fireflies free tier limits not confirmed this session. Google Workspace Business tier prices with Gemini not confirmed.
- No Vietnam-specific pricing (VND, local billing) found for any product.

### 4. Privacy and data: training, retention, hosting, incidents and lawsuits

#### Takeaway
The main 2025-2026 legal risk is wiretap and biometric law: the consolidated Otter class action survived a motion to dismiss on its core claims (Aug 2026), Fireflies faces two Illinois BIPA voiceprint suits, and Granola was also sued. Training on customer meeting data is the other flashpoint (Otter allegations; Zoom's 2023 terms backlash). EU hosting (tl;dv) and opt-in training (Read) are the vendors' answers.

#### Cited Findings
**Otter.ai litigation**
- Brewer v. Otter.ai filed Aug 2025 in N.D. Cal.; alleges Otter Notetaker and OtterPilot recorded and used private conversations without consent of all participants and used audio to improve its algorithms; centered on a 24 Feb 2025 Zoom meeting , [NPR, 15 Aug 2025](https://www.npr.org/2025/08/15/g-s1-83087/otter-ai-transcription-class-action-lawsuit); [National Law Review](https://natlawreview.com/article/ai-notetaking-tools-under-fire-lessons-otterai-class-action-complaint)
- Consolidated as In re Otter.AI Privacy Litigation, No. 5:25-cv-06911-EKL (N.D. Cal.), combining Brewer, Walker, Theus and Winston , [basilai.app (May 2026 hearing)](https://basilai.app/articles/2026-06-21-in-re-otter-ai-privacy-litigation-may-2026-hearing-explained.html); [UC Today](https://www.uctoday.com/security-compliance-risk/otter-ai-on-trial-and-the-ai-notetaker-industry-with-it/)
- 13 Aug 2026 order by Judge Eumi K. Lee granted Otter's motion to dismiss in part and denied it in part; surviving claims reportedly include federal Wiretap Act, California Invasion of Privacy Act (CIPA) and Illinois BIPA voiceprint claims; CFAA and some others dismissed with leave to amend; pleading stage only, no finding of liability , [CourtListener order PDF](https://storage.courtlistener.com/recap/gov.uscourts.cand.454675/gov.uscourts.cand.454675.68.0.pdf); [UC Today, "Otter.ai fails to dismiss core privacy claims"](https://uctoday.com/productivity-automation/otter-ai-fails-to-dismiss-core-privacy-claims-in-u-s-court/); [idtechwire, BIPA voiceprint claims](https://idtechwire.com/otter-ai-must-face-voiceprint-claims-under-illinois-biometric-law/); [Courthouse News PDF, Aug 2026](https://www.courthousenews.com/wp-content/uploads/2026/08/otter-ai-privacy-class-action.pdf)
- Reported later docket: 16 Sep 2026 scheduling order set class certification motion deadline of 13 May 2027; Otter answered 17 Sep 2026 , single secondary source, UNVERIFIED , [openclassactions](https://openclassactions.com/lawsuits/otter-ai-privacy-wiretap-class-action.php)
- Reported defense: consent belongs to the account holder; Otter has not commented publicly , [getvoibe "Is Otter safe"](https://www.getvoibe.com/resources/is-otter-safe/)
- A UC Today piece reports a claim about the bot recording after the call ended , [UC Today](https://www.uctoday.com/security-compliance-risk/otter-ai-lawsuit-meeting-bot-recording-after-call/) (details not read)

**Fireflies.ai litigation (BIPA)**
- Cruz v. Fireflies.AI Corp., No. 3:25-cv-03399 (C.D. Ill., filed Dec 2025): speaker recognition allegedly created and retained a voiceprint without BIPA written notice and consent; no published biometric retention/destruction policy; plaintiff never had a Fireflies account, joined a meeting hosted by an Illinois nonprofit that enabled Fireflies , [National Law Review](https://natlawreview.com/article/lawsuit-alleges-firefliesai-corp-illegally-collects-biometric-data-virtual-meetings); [Epstein Becker Green](https://www.ebglaw.com/insights/publications/ai-meeting-assistants-and-biometric-privacy-lessons-from-the-fireflies-ai-lawsuit); [Top Class Actions, 19 Mar 2026](https://topclassactions.com/lawsuit-settlements/lawsuit-news/fireflies-ai-sued-over-alleged-unlawful-data-collection-from-meeting-participants)
- Fricker v. Fireflies.AI Corp., No. 1:26-cv-02675 (N.D. Ill., 2026), similar voiceprint claims , [Workplace Privacy Report, Apr 2026](https://www.workplaceprivacyreport.com/2026/04/articles/artificial-intelligence/ai-meeting-assistants-and-biometric-privacy-governance-lessons-from-the-fireflies-ai-lawsuit/)
- BIPA can apply if any participant is physically in Illinois; damages $1,000 per negligent and $5,000 per intentional violation , [illinoislawyernow, Feb 2026](https://www.illinoislawyernow.com/2026/02/employers-beware-uptick-in-bipa-lawsuits-targeting-ai-note-taking-software/); [openclassactions investigation](https://openclassactions.com/investigations/fireflies-ai-notetaker-bipa-privacy-investigation.php)
- No ruling or settlement found in the Fireflies cases.
- Granola: Chamberlain v. Granola listed as joining the line of notetaker cases , [AI Incident Database](https://incidentdatabase.ai/cite/1651/); [tooldirectory 2026 roundup](https://tooldirectory.ai/blog/ai-notetaker-lawsuits-2026) (says no case found against Read AI as of its date)

**Training and hosting**
- Zoom, Aug 2023: terms revised in March 2023 read as allowing AI training on user content; Zoom then stated "we do not use audio, video, or chat content for training our models without customer consent" and added it to the terms; CEO called it a process failure , [The Record](https://therecord.media/zoom-terms-of-service-ai); [Axios, 9 Aug 2023](https://www.axios.com/2023/08/09/zooms-terms-service-changes-ai-fears) (dated 2023)
- tl;dv: data primarily processed and stored in the EEA (Germany, Finland), except part of the AI processing depending on chosen hosting location; reviews say its DPA prohibits training on personal data (not confirmed) , [tl;dv privacy policy](https://tldv.io/privacy/); [tl;dv help center](https://intercom.help/tldv/en/articles/9969995-data-privacy-how-does-tl-dv-comply-with-uk-eu-data-protection-requirements)
- Read.ai: model training opt-in, except a "Customer Experience Improvement Program" reported as opt-out by default; another write-up quotes the policy as opt-in , conflict UNRESOLVED , [layer3labs Read AI](https://www.layer3labs.io/guides/read-ai-pricing); [checkthat.ai](https://checkthat.ai/brands/read-ai/pricing)
- Google Meet admin explicit-consent setting (May 2026) , [Google Workspace Updates](https://workspaceupdates.googleblog.com/2026/04/require-explicit-consent-for-take-notes-with-Gemini-recordings-and-transcripts-in-Google-Meet.html)

#### Inferences
- The lawsuits target four things Ludy already designs against or should: (1) consent from only the account holder, (2) recording people who are not users, (3) speaker recognition creating stored voiceprints without notice and a retention policy, (4) training on meeting content. Ludy's consent record, retention, crypto-shredding and "AI output is a draft a person approves" map directly to these. Speaker diarization that stores voice embeddings across meetings is the riskiest feature to add; per-meeting labels without persistent voiceprints avoid the BIPA fact pattern.
- Vietnam's Decree 13/2023 on personal data protection (and the 2025 Personal Data Protection Law) is the relevant local regime; not researched here.

#### Gaps
- Otter, Fireflies and Fathom current training policies and retention defaults not confirmed from primary pages.
- Regional hosting in Asia (Singapore, Vietnam) for any vendor not found.
- Vietnamese law on recording consent (one-party vs all-party) not researched in this session.

### 5. What users praise and complain about

#### Takeaway
Praise centers on time saved, cross-meeting Q&A (AskFred), Fathom's generous free tier and CRM logging. Complaints center on bots auto-joining and spreading through meetings, summaries emailed to everyone, credit and minute caps, team-oriented pricing, mixed accuracy on names and non-English, and the privacy lawsuits.

#### Cited Findings
- Praise: AskFred "one of the best AI assistants I've used", searches across all meetings and cites them , [tl;dv Fireflies review](https://tldv.io/blog/fireflies-review/) (competitor)
- Praise: Fathom's free plan as the most generous (unlimited recordings) , [Circleback comparison](https://circleback.ai/blog/ai-meeting-notetaker-pricing-compared); "The free plan is real. The catch is call six" , [getvoibe Fathom pricing](https://www.getvoibe.com/resources/fathom-pricing/)
- Complaint: auto-join of all calendar meetings (Read, Otter) and invitee emails with partial transcripts , [tl;dv lawsuits blog](https://tldv.io/blog/ai-meeting-recorder-lawsuits/)
- Complaint: notetakers "spread like viruses" across organizations , [Synk](https://synk.to/blog/detect-and-stop-ai-notetakers)
- Complaint: Fireflies AI credits pause features at the cap; auto-enrollment into credit purchases reported , [wave.co](https://wave.co/compare/fireflies-ai-review); [skillscouter](https://skillscouter.com/fireflies-review/)
- Complaint: Fireflies accuracy mixed, stumbles on repeated names , [tl;dv Fireflies review](https://tldv.io/blog/fireflies-review/); Fireflies Trustpilot page has 517 reviews (content not read) , [Trustpilot](https://ca.trustpilot.com/review/fireflies.ai)
- Complaint: Fireflies priced and designed around teams , [onyxranked](https://onyxranked.com/fireflies-ai-review-2026/)
- Complaint: Copilot in Teams works best in English; non-English summaries and action items less accurate , [getvoibe Teams](https://www.getvoibe.com/resources/best-ai-note-taker-for-microsoft-teams/) (early 2026)
- Complaint: Notion browser capture misses other participants with headphones; speaker labels English-only , [Scribbl Notion](https://scribbl.co/post/notion-ai-meeting-notes)
- Complaint: Gemini notes handle one language at a time, no code-switching , [HappyScribe](https://www.happyscribe.com/blog/take-notes-in-google-meet-meetings)
- Ratings: Fireflies 4.8/5 on G2 (500+ reviews) per one aggregator vs 4.2/5 from a blog , [G2](https://www.g2.com/products/fireflies-ai/reviews); [mrktcorrect](https://mrktcorrect.com/blog/fireflies-ai-review)

#### Inferences
- Vietnamese meetings commonly mix Vietnamese and English terms; single-language-per-meeting limits (Gemini) and English-only speaker labels (Notion) are concrete gaps Ludy can target.
- "No bot, no auto-email to guests, no surprise credits" is a defensible positioning line drawn straight from the complaints.

#### Gaps
- No Reddit or Hacker News threads surfaced in search results; user sentiment here is from review blogs (many written by competitors) and G2/Trustpilot listings that could not be opened.
- No Vietnamese-language user reviews found.

## Notes: newcomers_vietnam


Method note: research done 2026-11-14 with web search. Full-page fetches failed for every host tried (siliconangle.com, circleback.ai, computerworld.com, vietnamnet.vn, fellow.ai, smartvoice.vnpt.vn, aimeetingassistantreviews.com: "host outside the session's allowed network domains"). So every finding below comes from search-result summaries of the cited pages, not from reading the full page. Treat exact numbers (prices, dates) as "reported by the cited page, not checked on the vendor's live pricing page". Many sources are vendor blogs or affiliate comparison sites; flagged where relevant.

### 1. Capture model: bot-free vs extension vs bot, why bot-free rose, consent trade-offs

#### Takeaway
By 2026 bot-free capture (desktop app recording system audio plus mic) is the default for the fast-growing products (Granola, Jamie, Krisp, Bluedot), and even bot-first products (Circleback, Supernormal) added a bot-free mode; but bot-free has become the center of US wiretap class actions (Chamberlain v. Granola, filed 2026-07-30), because nobody else in the call sees a recorder join.

#### Cited Findings
- Granola captures audio directly from the user's computer, so it transcribes without appearing as a meeting participant; this design is central to the class action filed 2026-07-30 in N.D. California by Florida resident Tarra Chamberlain, alleging violation of California's all-party consent law (CIPA) and that meeting data is used for AI training by default. Allegations untested in court. , [ppc.land](https://ppc.land/granola-sued-for-recording-meetings-without-consent-to-train-ai-models/); [Computerworld](https://www.computerworld.com/article/4206255/granola-lawsuit-raises-concerns-over-ai-note-taking-app-privacy.html); [ConsentPixel case summary](https://consentpixel.com/blogs/granola-ai-notetaker-wiretap-litigation/); [MIT AI Risk incident 1652](https://airisk.mit.edu/ai-incidents/1652-granola-ai-notetaker-allegedly-captured-and-transcribed)
- Other pending notetaker suits: a similar case against Otter.ai in the same district (filed 2025) and Cruz v. Fireflies.AI Corp. in Illinois federal court; one tracker lists a Microsoft Teams BIPA suit filed 2026-02-05 (unverified). , [BuildBetter blog, 2026](https://blog.buildbetter.ai/ai-notetaker-lawsuits-2026-how-to-record-meetings-legally/); [tooldirectory.ai](https://tooldirectory.ai/blog/ai-notetaker-lawsuits-2026)
- Jamie runs on the user's device and no bot joins the call. , [HappyScribe, 2026](https://www.happyscribe.com/blog/jamie-alternatives-for-ai-meeting-notes); [Jamie's own blog](https://www.meetjamie.ai/en/blog/bot-free-ai-note-takers)
- Krisp evolved from noise cancellation into a bot-free AI meeting assistant with on-device capture. , [Krisp blog (vendor), 2026](https://krisp.ai/blog/ai-note-taking-apps/); [fellow.ai, 2026](https://fellow.ai/blog/bot-free-ai-note-takers/)
- Bluedot and Krisp default to bot-free capture but also sell a bot; Bluedot is bot-free by default with bot recording available when needed. , [fellow.ai, 2026](https://fellow.ai/blog/bot-free-ai-note-takers/); [stork.ai, 2026](https://www.stork.ai/blog/ai-note-taker-no-bot-2026)
- Circleback's bot-free mode sits alongside an optional bot rather than replacing it; it covers Zoom, Google Meet, Teams, Slack huddles and in-person meetings. , [Circleback blog (vendor)](https://circleback.ai/blog/ai-notetakers-without-a-bot); [circleback.ai/llms.txt](https://circleback.ai/llms.txt)
- Tactiq captures live captions from meeting platforms through a browser extension (no audio bot). Supernormal offers a bot-free recording option through a Chrome extension. , [fellow.ai, 2026](https://fellow.ai/blog/bot-free-ai-note-takers/); [whisperai.com, 2026](https://whisperai.com/blog/best-ai-note-takers-and-ai-meeting-assistants)
- Granola's bot-free design is marketed as "bot-free meeting intelligence" and is a main selling point in 2026 coverage. , [agmazon.com, 2026-05](https://agmazon.com/blog/articles/technology/202605/granola-ai-note-en.html); [university-365](https://www.university-365.com/post/granola-the-ai-meeting-notepad-that-records-from-your-own-device-without-a-bot-in-the-call)
- Wearable capture: Meta acquired Limitless (maker of the AI Pendant that records and summarizes in-person conversations) on 2025-12-05; Pendant sales stopped, existing users supported for at least a year, team moved into Reality Labs; users must accept a new privacy policy. , [CNBC, 2025-12-05](https://www.cnbc.com/2025/12/05/meta-limitless-ai-wearable.html); [mlq.ai](https://mlq.ai/news/meta-acquires-ai-wearables-startup-limitless-ending-sales-of-pendant-device/); [becomefluent.io, 2026-05](https://becomefluent.io/blog/2026-05/what-happened-to-limitless-pendant/)
- Vietnam: the Personal Data Protection Law (Law 91/2025/QH15), passed 2025-06-26, took effect 2026-01-01; Decree 356/2025/ND-CP replaces Decree 13/2023 and also took effect 2026-01-01. , [thuvienphapluat.vn](https://thuvienphapluat.vn/van-ban/Bo-may-hanh-chinh/Luat-Bao-ve-du-lieu-ca-nhan-2025-so-91-2025-QH15-625628.aspx?tab=7); [EY Vietnam legal alert, 2026-03](https://www.ey.com/content/dam/ey-unified-site/ey-com/vi-vn/technical/tax/documents/ey-vietnam-legal-alert-march-2026-decree-no356-2025-nd-cp-providing-detailed-guidance-for-implementation-of-personal-data-protection-law-viet.pdf); [PwC Vietnam, 2025-08-11](https://www.pwc.com/vn/vn/publications/legal-news-brief/250811-personal-data-protection-law.html)
- Decree 356 broadens valid forms of consent to match practice, for example consent given in a recorded call (EY summary). Recording calls without the user's consent is prohibited unless the law provides otherwise; fines for misuse of personal data reported up to 3 billion VND. , [EY Vietnam](https://www.ey.com/vi_vn/technical/tax/tax-and-law-updates/nghi-dinh-so-356-2025-nd-cp-quy-dinh-chi-tiet-mot-so-dieu-va-bien-phap-thi-hanh-luat-bao-ve-du-lieu-ca-nhan); [lsvn.vn](https://lsvn.vn/su-dung-du-lieu-ca-nhan-sai-trai-co-the-bi-phat-den-03-ti-dong-a167866.html); [lsvn.vn, changes from 2026-01-01](https://lsvn.vn/mot-so-thay-doi-can-luu-y-trong-xu-ly-du-lieu-ca-nhan-tu-01-01-2026-a167892.html)

#### Inferences
- Bot-free won on friction and social awkwardness (no "X's Notetaker joined" tile, works on any call app incl. phone/in-person), but it shifts the disclosure duty entirely onto the user. Ludy's existing consent record is a differentiator: making the disclosure step part of starting a capture (a one-click "announce in chat" text in Vietnamese, plus the stored consent record) directly answers the failure mode in the Granola suit.
- "Training on customer meeting data by default" is a second, separable liability in the Granola complaint; Ludy should state and enforce "no training on tenant audio/transcripts" and keep it off by default.
- The hybrid pattern (bot-free default, optional bot or extension where a visible recorder is wanted) is now standard; Ludy's extension tab capture plus in-app mic already covers the bot-free side without a desktop app.

#### Gaps
- Could not read the complaint text or Granola's response (Computerworld fetch failed); whether Granola changed defaults after the suit is unknown.
- No source found on whether Vietnamese law classifies voice recordings as sensitive personal data, or on specific rules for recording internal meetings with third parties; needs reading Law 91/2025 and Decree 356 directly or a lawyer.
- Cluely-style "invisible" live assistants and Shadow were not researched (out of tool budget).

### 2. Standout UX ideas in newer products

#### Takeaway
The products gaining share compete less on transcription and more on what happens around the notes: the user's own notes enhanced by AI (Granola), saved prompts / templates (Granola Recipes, Jamie 30+ templates), agentic chat across all meetings with citations, automations and webhooks (Circleback), and MCP servers so Claude/ChatGPT/Cursor can read meeting memory (Granola, Circleback), plus people/company views and mobile/watch capture.

#### Cited Findings
- Granola MCP launched 2026-02-04, connecting meeting notes to Claude, ChatGPT, Cursor and other MCP clients; a later update added public APIs and updates to MCP and Spaces (team conversation context). , [releases.sh, "Introducing Granola MCP"](https://releases.sh/release/rel_DT7GWSS8cbBfekJB4gZwn-introducing-granola-mcp); [granola.ai/updates](https://granola.ai/updates)
- Around 2026-04-21 Granola Chat was rebuilt as agentic, faster across a user's notes, Team Space and shared notes, with inline citations and "Recipes" (saved expert-written prompts that run on meeting notes). , [releasebot.io Granola release notes](https://releasebot.io/updates/granola); [granola.ai/updates](https://granola.ai/updates)
- Granola has People and Companies views with Attio and Zapier integrations (predates 2026). , [releasebot.io](https://releasebot.io/updates/granola)
- Granola mobile: Android launched 2026 (Granola's timeline says 2026-07-01, an aggregator says 2026-03-25: conflicting); a rebuilt Apple Watch app for meetings away from a laptop (2026-07); iPhone supports outbound phone calls being captured. , [granola.ai/updates](https://granola.ai/updates); [releasebot.io](https://releasebot.io/updates/granola)
- Granola has an OpenAI (ChatGPT) business plugin listing. , [openai.com plugin page](https://openai.com/uk-UA/business/plugins/granola/)
- Circleback exposes meeting context to AI agents through an MCP server (OAuth; notes, transcripts, calendar events and emails; existing Circleback permissions apply), a CLI, and webhooks. One directory warns Circleback does not publish the MCP response schema, so whether private notes cross that boundary is unconfirmed. , [circleback.ai/llms.txt](https://circleback.ai/llms.txt); [Circleback blog: connect MCP](https://circleback.ai/blog/how-to-connect-circleback-mcp); [tooldirectory.ai, reviewed 2026-11-08](https://tooldirectory.ai/tools/circleback)
- Circleback Automations: a webhook step POSTs JSON to a chosen HTTPS URL after each matching meeting; the user picks fields (notes, action items, transcript, insights, recording, metadata); multiple webhooks allowed; past meetings can be pushed through an automation from the Actions menu. , [Circleback docs: webhooks](https://circleback.ai/docs/webhook-integration); [Circleback release note](https://circleback.ai/releases/webhook-integration-in-automations); [Hookdeck guide](https://hookdeck.com/webhooks/platforms/guide-to-circleback-webhooks-features-and-best-practices.md)
- Jamie produces "executive level" notes with 30+ templates on all plans (vendor claim). , [Jamie blog (vendor)](https://www.meetjamie.ai/en/blog/bot-free-ai-note-takers)
- Bluedot: 100+ languages, CRM auto-sync. Supernormal: notes segmented by topics and action items. MeetGeek: favored for meeting analytics / conversation intelligence. , [fellow.ai, 2026](https://fellow.ai/blog/bot-free-ai-note-takers/); [whisperai.com, 2026](https://whisperai.com/blog/best-ai-note-takers-and-ai-meeting-assistants)
- Otter.ai expanded simultaneous translation and summary across 30 languages including Vietnamese. , [VnReview](https://vnreview.vn/threads/otter-ai-nang-cap-nang-luc-dich-va-tom-tat-cuoc-hop-dong-thoi-qua-30-ngon-ngu.94326/) (date not shown in result)
- Vietnamese product CIAXI AI Meeting Assistant can connect to ChatGPT or Claude to answer questions about meeting content (ICSC, 2026-07-03). , [ICSC](https://icsc.vn/2026/07/03/ciaxi-ai-meeting-assistant-khi-ghi-chu-cuoc-hop-khong-con-la-ganh-nang/?lang=vi)

#### Inferences
- For Ludy the cheap, high-value lessons: (a) let the user type rough notes during the meeting and have the AI expand them (Granola's core loop), which fits "live notes" already in Ludy; (b) "Recipes" = saved prompts per meeting type (sales call, 1:1, giao ban), naturally Vietnamese templates for biên bản; (c) chat across meetings with inline citations to transcript lines (Ludy's search already exists; citations make AI output checkable, matching "AI output is tainted"); (d) outbound webhooks on "meeting notes approved" rather than on raw AI output, so only human-approved data leaves; (e) an MCP endpoint scoped by tenant permissions, with an explicit published schema (Circleback's gap).
- People/company memory maps directly onto Ludy's CRM links: the CRM contact page can show "last meetings, open action items".

#### Gaps
- Krisp, Jamie, Bluedot, Tactiq, MeetGeek and Supernormal 2025-2026 changelogs and funding were not found in search results (one search returned only comparison listicles).
- Notion AI Meeting Notes, Cluely, Shadow and Superwhisper were not researched (budget).

### 3. Pricing for solo and small teams; free tier limits

#### Takeaway
Paid tiers cluster at about $8-25 per user per month; free tiers are limited by history window (Granola, Circleback: 30 days) or by note count (Jamie 10/month, Bluedot 5 total, Krisp 2 summaries/day). Sources conflict often; verify on vendor pages.

#### Cited Findings
- Granola: raised $125M Series C in 2026-03 at $1.5B valuation (Index Ventures lead; Kleiner Perkins, Lightspeed, Spark, NFDG), ~$192M total across four rounds, valuation up from $250M less than a year earlier; revenue reportedly grew 250% in the prior quarter (Bloomberg via SiliconANGLE). , [SiliconANGLE, 2026-03-25](https://siliconangle.com/2026/03/25/granola-raises-125m-1-5b-valuation-ai-note-taking-app/); [benzoicai.com](https://benzoicai.com/blog/granola-hits-1-5b-why-ai-meeting-notes-just-became-a-serious-category/)
- Granola pricing: Basic free, Business $14/user/month (better models, cloud integrations), Enterprise $35/user/month. Free tier conflict: most sources say no meeting cap but only last 30 days of notes visible; one says a lifetime cap of 25 notes. , [SiliconANGLE](https://siliconangle.com/2026/03/25/granola-raises-125m-1-5b-valuation-ai-note-taking-app/); [Scribbl](https://scribbl.co/post/granola-pricing); [mrktcorrect](https://www.mrktcorrect.com/blog/granola-pricing); contradicted by [hirekai.ai](https://hirekai.ai/blog/granola-review)
- Circleback: free plan with unlimited meetings, notes, action items, plus API, MCP and CLI access, limited to 30 days of history; Pro $15/user/month adds unlimited history and automations. Conflicting older third-party figures: Individual ~$20.83/user/month annual, Team $25; some reviews say trial only. , [circleback.ai/llms.txt](https://circleback.ai/llms.txt); [Circleback blog](https://circleback.ai/blog/best-free-ai-meeting-notes-app); contradicted by [aimeetingassistantreviews.com](https://www.aimeetingassistantreviews.com/reviews/circleback/)
- Jamie: free 10 AI notes/month, 30-minute meeting limit; Plus €25/month, Pro €47/month (another source: Plus from $24/user/month). , [HappyScribe, 2026](https://www.happyscribe.com/blog/jamie-alternatives-for-ai-meeting-notes); [stork.ai](https://www.stork.ai/blog/ai-note-taker-no-bot-2026)
- Bluedot: free 5 meetings total; paid listed at $18/$25/$39 per month by one source, from $14/month by another. , [meetingnotes.com](https://meetingnotes.com/blog/bot-free-ai-note-takers-alternatives); [meaty.me](https://meaty.me/blog/bot-free-ai-notetakers)
- Krisp ~$8/month billed annually (cheapest paid bot-free); free plan limits AI summaries to 2 per day. Tactiq $8/month annual. MeetGeek $9.99/user/month annual. , [stork.ai](https://www.stork.ai/blog/ai-note-taker-no-bot-2026); [whisperai.com](https://whisperai.com/blog/best-ai-note-takers-and-ai-meeting-assistants); [thebusinessdive.com](https://thebusinessdive.com/ai-note-taker)
- NoteX (Vietnam, Sota Labs) App Store VN prices: Essential Lifetime 2,999,000 VND; Plus Monthly 199,000 VND; Pro Weekly 99,000 VND; Pro Monthly 399,000 / 499,000 VND; Pro Yearly 4,999,000 VND (US store: Pro Monthly $16.99, Lifetime $99.99). , [App Store VN](https://apps.apple.com/vn/app/notex-ghi-ch%C3%BA-h%E1%BB%8Dp-ai/id6654910983?l=vi); [App Store US](https://apps.apple.com/us/app/notex-ai-notes-meetings/id6654910983)

#### Inferences
- The 30-day-history free tier (Granola, Circleback) is a now-common hook: unlimited capture, pay for memory. For Ludy (open source, self-hostable) the comparable lever is the AI budget meter, not history.
- At 199k-499k VND/month, Vietnamese consumer apps price near Western tools; an SME bundle inside a Business OS is a clear price wedge.

#### Gaps
- No vendor pricing page could be read directly; all figures are second-hand.
- No VND price list found for MiRA, 1Office AI Meeting, Meet AI+, M-Meeting, CIAXI, VNPT SmartVoice or Viettel AI ASR (Viettel's page reportedly lists tiered prices, not captured).

### 4. Vietnamese products: WER claims, VND pricing, on-prem, data residency, users

#### Takeaway
Vietnam has a crowded field of local meeting-minutes apps (NoteX, MiRA, 1Office AI Meeting, Miichisoft Meet AI+, HBLAB M-Meeting, ICSC CIAXI, NoteMeeting) plus speech APIs from the big groups (Viettel AI, VNPT SmartVoice, FPT.AI); accuracy claims are vendor-only (NoteX "99.2%") and no independent Vietnamese WER benchmark of these products was found.

#### Cited Findings
- NoteX AI (Sota Labs): generates minutes about 5 minutes after the meeting, lists key decisions and per-member to-dos; vendor claims 99.2% Vietnamese transcription accuracy via a "hybrid AI architecture" (unverified). Covered by VietNamNet and VnExpress. , [VietNamNet](https://vietnamnet.vn/notex-ai-tro-ly-cuoc-hop-thong-minh-cho-doanh-nghiep-2490608.html); [VnExpress, "Lợi thế của sản phẩm trí tuệ nhân tạo Việt"](https://vnexpress.net/loi-the-cua-san-pham-tri-tue-nhan-tao-viet-5041152.html)
- MiRA (mira.ai.vn): records system audio, real-time translation across 60+ languages, multilingual minutes; B2B demo booking and "Enterprise pricing" (not shown). , [mira.ai.vn](https://mira.ai.vn/)
- 1Office AI Meeting: records, transcribes, summarizes and suggests follow-up tasks, optimized for Vietnamese; positioned as "thư ký số" for leaders inside the 1Office business suite. , [1office.vn/ai-meeting](https://1office.vn/ai-meeting)
- Miichisoft Meet AI+: minutes in the company's own template from audio or video files, optimized for Vietnamese and Japanese. HBLAB M-Meeting: recording, transcription, summary and real-time interpretation. , [Miichisoft](https://miichisoft.com/vi/meet-ai-meeting-assistant/); [HBLAB](https://hblab.vn/m-meeting-tro-ly-hop-tich-hop-ai-giup-xu-dep-rao-can-ngon-ngu/)
- ICSC CIAXI AI Meeting Assistant (2026-07-03): connects to ChatGPT or Claude for Q&A on meetings. NoteMeeting: Vietnamese-built, focused on Google Meet. Anpiso: browser tool using the user's own Gemini API key (vendor claim). , [ICSC](https://icsc.vn/2026/07/03/ciaxi-ai-meeting-assistant-khi-ghi-chu-cuoc-hop-khong-con-la-ganh-nang/?lang=vi); [hvn.vn](https://hvn.vn/cong-cu-tao-bien-ban-cuoc-hop-tu-dong/); [anpiso.fechtin.com](https://anpiso.fechtin.com/)
- Viettel AI speech recognition: lists interviews/conferences and meeting minutes and smart meeting rooms as use cases; handles Vietnamese accents and auto-punctuation; tiered pricing listed (figures not captured; pages may be dated). , [Viettel AI ASR](https://viettelgroup.ai/en/service/asr); [viettelai.vn](https://viettelai.vn/en/tin-tuc/phan-mem-chuyen-giong-noi-thanh-van-ban)
- VNPT SmartVoice: speech-to-text for recording and transcribing meetings via web, a "Voice Meeting" app, or API/SDK; a review says it is more a technology/integration platform than a full meeting-management workflow. , [VNPT SmartVoice use case](https://smartvoice.vnpt.vn/vi/usecase/speech-to-text); [salekit PDF](https://vnptai.io/files/vnpt_smartvoice_salekit-vi.pdf); [hvn.vn](https://hvn.vn/phan-mem-chuyen-giong-noi-thanh-van-ban/)
- FPT.AI: deep-learning speech-to-text trained on Vietnamese, browser or API. , [ACM paper citing FPT.AI](https://dl.acm.org/doi/fullHtml/10.1145/3638584.3638634)
- Vbee AIVoice is mainly a voice (TTS) platform with STT via API; no meeting-minutes product found. No Zalo AI meeting product found. VinBigData appears only as the VinBigdata-VLSP2020 corpus (about 20 h read + 80 h spontaneous speech); viVoice is an FPT University TTS dataset (1,017+ h), not a transcription tool. , [vbee.ai/products](https://vbee.ai/products); [MDPI corpus paper](https://www.mdpi.com/2079-9292/13/5/977); [VietSuperSpeech arXiv](https://arxiv.org/html/2603.01894)
- Vietnamese roundups recommend Fireflies (Vietnamese must be set manually in Meeting Settings), Zoom AI Companion, Teams Copilot, Lark Minutes, Notta for Vietnamese meetings; say Otter and Fathom handle Vietnamese poorly (Otter's later 30-language update contradicts this for Otter). , [topon.tech](https://topon.tech/vi/ai-ghi-chep-cuoc-hop-mien-phi/); [vieclam24h](https://vieclam24h.vn/nghe-nghiep/tram-sac-ky-nang/ai-ghi-chep-cuoc-hop); [vinagroup (Lark reseller)](https://vinagroup.com.vn/kien-thuc-lark-suite/ai-meeting-note-lark-suite.html); contradicted by [VnReview](https://vnreview.vn/threads/otter-ai-nang-cap-nang-luc-dich-va-tom-tat-cuoc-hop-dong-thoi-qua-30-ngon-ngu.94326/)
- One Vietnamese guide recommends a person checks, edits and confirms minutes before official use. , [devin.vn academy](https://devin.vn/academy/02-office/workflow-automation/01-meeting-notes)

#### Inferences
- The local winners bundle minutes into an existing suite (1Office) or sell B2B with demos (MiRA, CIAXI); a free, open-source, self-hostable module inside a Business OS, with data in the tenant's own Postgres, is a credible counter-position for Decree 356 / Law 91 conscious SMEs.
- "Biên bản in the company's own template" (Meet AI+) is a Vietnam-specific need: formal biên bản layout (thời gian, địa điểm, thành phần, nội dung, kết luận, chữ ký).

#### Gaps
- No independent Vietnamese WER benchmark for any named product; no on-prem/data-residency statements captured for NoteX, MiRA, 1Office (pages not fetchable).
- User counts for Vietnamese products not found.

### 5. What users praise and complain about

#### Takeaway
Praise centers on no-bot discretion and notes that read like the user's own; complaints center on speaker labels (Granola "Me/Them"), missed captures, language coverage (non-English), hallucinated meaning changes, and privacy/consent.

#### Cited Findings
- Granola desktop labels dialogue as "Me" and "Them"; accuracy reportedly drops with 3+ participants; newer accounts have speaker tags on by default, but transcripts recorded before enabling stay unnamed. , [anarlog.so](https://anarlog.so/blog/granola-ai-complaints/); [tldv.io review (competitor)](https://tldv.io/blog/granola-review/)
- One founder reported Granola open all day produced notes for only ~60% of calls. , [hirekai.ai](https://hirekai.ai/blog/granola-review)
- An App Store reviewer said Granola notes often hallucinate and change meaning (single review). A Product Hunt reviewer rated 2/5 because Chinese is not supported. , [anarlog.so](https://anarlog.so/blog/granola-ai-complaints/); [Product Hunt](https://www.producthunt.com/p/granola)
- Privacy complaint: capture without telling most participants, training by default (lawsuit). , [ppc.land](https://ppc.land/granola-sued-for-recording-meetings-without-consent-to-train-ai-models/)

#### Inferences
- Speaker diarization and per-language quality are where a Vietnamese-first tool can win; showing speaker names linked to CRM contacts helps.
- A visible "capture health" indicator (recording / not recording) addresses missed-capture complaints.

#### Gaps
- No Reddit or Hacker News threads surfaced; most complaint sources are competitor blogs. Praise for Jamie, Bluedot, Krisp, Circleback not gathered.

## Notes: zoom_google_microsoft


Method note (read first): this session's network blocked direct fetches of every vendor documentation host tried (developers.zoom.us, devforum.zoom.us, developers.google.com, learn.microsoft.com all failed DNS resolution; the session's network settings would have to allow them). Every claim below therefore comes from web-search result snippets that quote or summarize the vendor pages, not from opening the page. A claim marked "(snippet)" is quoted from a search snippet of the named URL; "(third-party)" means the source is not the vendor. Dates are the source's own date where shown. Nothing here was verified on a live vendor page.

### Zoom: app types, RTMS, pricing, App Review, participant notice, Zoom Apps, recordings/transcripts, webhooks, Meeting SDK bots

#### Takeaway
Zoom's official real-time route is RTMS (Realtime Media Streams): audio, video and transcript pushed over WebSocket to an app, billed per streaming minute against Zoom Developer Pack credits, with an in-meeting App Activity Notification participants can use to pause/stop it. The after-meeting route (cloud recording + transcript via REST and `recording.completed` / `recording.transcript_completed` webhooks) is mature but needs cloud recording on the host's (paid) account. Meeting SDK bots joining other accounts' meetings now need OBF tokens and can only stay while their authorizing user is in the meeting, which kills the "bot joins any meeting" model.

#### Cited Findings
RTMS
- RTMS requires Zoom Developer Pack credits on the account; plan options are on the Developer pricing page; volume discounts/commitments above 500 credits go to sales (snippet of Zoom docs, quoted in search summary) , [Zoom devforum: RTMS Developer Pack pricing for Business account](https://devforum.zoom.us/t/rtms-developer-pack-pricing-for-business-account/144203)
- Zoom staff on the forum: RTMS is charged per minute, no monthly fee when unused; rates are under "view credit rates" on the developer pricing page (snippet) , [Zoom devforum: RTMS feature annual fee](https://devforum.zoom.us/t/rtms-feature-annual-fee/143811)
- Reported rate: 0.01 credit per minute without transcription, 0.02 per minute with transcription enabled; another staff-quoted figure says $0.01 per streaming minute without transcription; a third thread says per-minute consumption is not published. Units (credits vs USD) conflict; unverified (snippets, 2026 forum threads) , [RTMS credit consumption per minute...](https://devforum.zoom.us/t/rtms-credit-consumption-per-minute-and-whether-the-initiating-participant-needs-a-paid-plan/145391/2); [Pricing & Feasibility Validation: RTMS vs. Linux SDK](https://devforum.zoom.us/t/pricing-feasibility-validation-rtms-vs-linux-sdk-for-external-meeting-capture/141332/2)
- Zoom staff: the RTMS free trial ended with the launch of the Developer Pack (snippet) , [Zoom devforum: Request to Enable RTMS for My Zoom Pro Account](https://devforum.zoom.us/t/request-to-enable-rtms-for-my-zoom-pro-account/144191)
- Open developer questions in 2026 on who pays (app developer vs host account) and whether Basic (free) hosts can use RTMS: thread titles "RTMS entitlement, Developer Pack billing ownership, and Basic meeting hosts" and "...whether the initiating participant needs a paid plan"; answers not readable , [devforum 146400](https://devforum.zoom.us/t/rtms-entitlement-developer-pack-billing-ownership-and-basic-meeting-hosts/146400); [devforum 145391](https://devforum.zoom.us/t/rtms-credit-consumption-per-minute-and-whether-the-initiating-participant-needs-a-paid-plan/145391)
- Zoom lets channel partners resell the Developer Pack (title only) , [Zoom news: Developer Pack resale for channel partners](https://news.zoom.com/zoom-announces-developer-pack-resale-for-channel-partners/)
- RTMS also exists for Zoom Contact Center (page title) , [Zoom docs: RTMS for Contact Center](https://developers.zoom.us/docs/rtms/contact-center/)
- Participant notice: participants see App Activity Notifications (AAN) when RTMS-enabled apps access content; they can view app details and the app user can pause or stop the app (snippet) , [Zoom docs: Participant user experience](https://developers.zoom.us/docs/rtms/meetings/ux-participant/)
- Zoom blog: anyone in the meeting can click the notifier to learn more, pause or stop access, or review the app's details from the meeting UI (snippet) , [Zoom developer blog: Improving UX for meeting assistant apps with RTMS](https://godevelopers.zoom.us/blog/improving-ux-rtms/)
- Changelog 2025-07-14 (desktop client 6.5.5): hosts can review and approve or deny participant app requests, with in-meeting controls (snippet) , [Zoom changelog RTMS 2025-07-14](https://developers.zoom.us/changelog/rtms/july-14-2025/)
- Changelog "RTMS June release" dated 2026-07-04: REST API apps can start RTMS for a participant under certain conditions, such as the participant being a meeting invitee (snippet) , [Zoom changelog RTMS 2026-07-04](https://developers.zoom.us/changelog/rtms/july-04-2026/)
- Third-party analysis of RTMS behavior and constraints exists (not opened) , [Recall.ai: Understanding Zoom RTMS behavior and its constraints](https://www.recall.ai/blog/understanding-zoom-rtms-behavior-and-its-constraints)

Meeting SDK bots (OBF)
- Zoom FAQ: beginning 2026-03-02, Zoom requires an On Behalf Of (OBF) token for Meeting SDK apps joining meetings hosted by external accounts (snippet) , [Zoom: FAQ - Updates to Meeting SDK authorization](https://developers.zoom.us/docs/meeting-sdk/obf-faq/); Recall.ai gives 2026-02-23 as enforcement start (conflict) , [Recall.ai: Zoom OBF](https://www.recall.ai/blog/zoom-obf)
- Bots and other non-human users can join with an OBF token tied to the authorizing account owner; OBF apps can join only once their verified owner is in the meeting/webinar and must leave when the owner leaves (snippet) , [Zoom docs: Join external meetings as a bot (OBF)](https://developers.zoom.us/docs/meeting-sdk/auth/obf/)
- So, correction to the design record: Zoom does document a bot route ("Join external meetings as a bot"), but constrained to the authorizing user's presence; it is not a "bot joins any meeting alone" route. I did not find the claimed wording "does not support bots" in any snippet.
- Developers report error 124 on cross-account OBF joins and that an unpublished app cannot be installed outside the developer account, which complicates testing (thread titles) , [devforum 144093](https://devforum.zoom.us/t/android-meeting-sdk-cross-account-obf-token-join-fails-with-error-124-works-for-own-account-meetings/144093); [devforum 145012](https://devforum.zoom.us/t/how-to-test-obf-token-implementation-with-external-zoom-accounts-if-unpublished-app-cant-be-installed-outside-developer-account/145012)
- ZAK-only joins are reportedly no longer sufficient for external meetings (forum) , [devforum: How will ZAK-based joins work after OBF rollout](https://devforum.zoom.us/t/how-will-zak-based-joins-work-after-obf-rollout-in-the-client-sdk/139075/11)

App Review
- No official 2026 review timeline found. Forum: a production app "stuck in Security Review for over 2 weeks" (August 2026); a Zoom App submitted 2026-09-08 had no status by 2026-09-15; adding a scope triggers a further security review "a few days" (snippets) , [Zoom devforum: App Submission category](https://devforum.zoom.us/c/marketplace/submission/40); [devforum: App approval timeline](https://devforum.zoom.us/t/app-approval-timeline/145877); [Zoom community](https://community.zoom.com/t5/Zoom-App-Marketplace/bd-p/marketplace/page/39)
- Forum posts titled "Zoom Marketplace Priority Review Process - How It Works" and "Important Update to Our App Review Submission Response Time" (October 2026) exist; content not readable , [devforum Marketplace tag](https://devforum.zoom.us/tag/marketplace)

Cloud recording, transcript, webhooks
- `recording.completed` fires each time a meeting recording is ready; payload has download URLs and a token (Zoom developer blog, snippet) , [Zoom blog: Meeting API querying tips part 4](https://developers.zoom.us/blog/meeting-api-querying-tips-part4/)
- Transcript arrives via a separate `recording.transcript_completed` event (forum) , [devforum 103087](https://devforum.zoom.us/t/how-to-access-meeting-transcript-from-recording-completed-webhook-event/103087/5); reports of it not firing , [devforum 136188](https://devforum.zoom.us/t/recording-transcript-completed-event-not-firing-webhook/136188)
- Intermittent 401 / errorCode 300 when downloading transcripts with the webhook download_token, and intermittent empty transcripts; Zoom staff recommend the Meeting API recording endpoint as fallback (forum + third-party) , [Recall.ai: intermittent errors downloading Zoom transcripts](https://www.recall.ai/blog/resolving-intermittent-errors-while-downloading-zoom-transcripts); [devforum 137898](https://devforum.zoom.us/t/discrepancies-between-get-meeting-recordings-and-get-a-meeting-transcript-endpoints-sometimes-transcript-event-results-in-an-empty-transcript-after-parse/137898)

#### Inferences
- For Ludy, Zoom RTMS is the only official live route that does not need a bot seat; the per-minute cost appears small (cents per hour if the 0.01-0.02 figures hold) but someone must hold Developer Pack credits. Who pays (vendor vs customer account) is unresolved in public sources.
- After-meeting cloud-recording transcripts are the cheapest route (no Zoom fee to the vendor) but require the customer to use cloud recording, which (from general knowledge, unverified here) is a paid Zoom plan feature.
- A self-hosted Ludy instance would need each operator to register its own Zoom app or use Crove Cloud's published app; an unpublished app only works inside the developer's own account, so external customers need App Review.

#### Gaps
- Official Marketplace app type list (General App, Server-to-Server OAuth, Meeting SDK, Webhook-only; from training knowledge, not verified in this session) and which types RTMS supports: not confirmed from a source.
- Official RTMS credit price in USD per credit and per minute, minimum purchase, and whether the host's or the app developer's account is billed: not found on a readable official page.
- Zoom Apps (in-client side panel) SDK capabilities (e.g. getMeetingContext): no result returned.
- Whether free (Basic) Zoom hosts can trigger RTMS: question exists on forum, answer not readable.
- App Review official steps and SLA: not found.

### Google: Meet add-ons SDK, Marketplace and OAuth verification (CASA), Meet REST API, Calendar, Media API replacement

#### Takeaway
Confirmed: Google is winding down the Meet Media API (the only real-time audio route) and turns its endpoints off on 2027-01-15; no replacement is named. The official routes left are the Meet REST API (after-meeting conference records, recordings, transcripts, smart notes; GA) and the Meet add-ons SDK (side panel / main stage UI; GA since 2024-09), which has no documented audio access. Restricted-scope apps need annual CASA Tier 2 assessment, roughly USD 540/year self-serve per community reports (unverified).

#### Cited Findings
- Meet REST API release notes (2026-10-28): "following our evaluation of the developer preview phase, and after feedback from the developer community, we have decided to wind down the Google Meet Media API"; endpoints turned off 2027-01-15, after which the API is inaccessible; Meet REST API and Meet Add-ons SDK (both GA) are unaffected (snippet) , [Google Meet REST API release notes](https://developers.google.com/workspace/meet/release-notes)
- Correction to the design record: the notice is a wind-down/shutdown decision, not "will not reach GA" wording; no GA plan and no named replacement in the snippets , same source.
- Media API had been in the Developer Preview Program since 2025-12-15 (snippet); Developer Preview terms say program features may not be included in public applications before GA (snippet) , [Google Workspace Developer Preview Program](https://developers.google.com/workspace/preview)
- A developer asks on Google's forum how a public Meet add-on can get real-time participant audio without a bot, noting the Media API audio scopes are restricted; no answer visible (snippet) , [discuss.google.dev thread 385365](https://discuss.google.dev/t/how-can-a-public-google-meet-add-on-access-real-time-participant-audio-without-a-bot/385365)
- Admins can control Media API access in Meet (page title) , [Google Workspace Admin: Control Media API access in Google Meet](https://knowledge.workspace.google.com/admin/meet/control-media-api-access-in-google-meet)
- Meet add-ons SDK for web GA in September 2024 , [Workspace Updates blog 2024-09](https://workspaceupdates.googleblog.com/2024/09/google-meet-add-ons-sdk-is-now-available.html); developer preview from 2023-12 , [Workspace Updates 2023-12](https://workspaceupdates.googleblog.com/2023/12/google-meet-add-ons-sdk-developer-preview.html)
- Add-on surfaces: side panel (entry point page) and main stage (via `startActivity()` when `mainStageUrl` is in the manifest, `MeetMainStageClient`; side panel can be closed with `unloadSidePanel()`); no admin control for the SDK itself, but add-on availability is controlled via Meet admin controls (snippets) , [Meet add-ons quickstart](https://developers.google.com/workspace/meet/add-ons/guides/use-SDK); [Workspace Updates 2024-09](https://workspaceupdates.googleblog.com/2024/09/google-meet-add-ons-sdk-is-now-available.html)
- No snippet confirmed either "add-ons have no audio" or a "must not rely on a bot" policy; the forum question above implies no GA audio route exists. Unverified.
- Meet REST API v2 has `smartNotes`, `transcripts` and transcript `entries` resources with get/list (snippet) , [Meet REST API v2 reference](https://developers.google.com/workspace/meet/api/reference/rest/v2)
- Release notes 2025-12-17: smartNotes subscription events in Developer Preview; smart notes files retrievable via get/list on smartNotes (snippet; current status may have changed) , [Meet REST API release notes](https://developers.google.com/workspace/meet/release-notes)
- Transcripts need a Workspace edition that supports transcription (admin help, snippet); third-party lists Business Standard, Business Plus, Enterprise tiers, Education Plus, Workspace Individual , [Google admin help 12076932](https://support.google.com/a/answer/12076932); [Nylas: 5 ways to get Google Meet transcriptions (2026)](https://www.nylas.com/blog/how-to-add-google-meet-transcription-to-your-app/)
- Meet API reached GA in February 2024 , [Workspace Updates 2024-02](https://workspaceupdates.googleblog.com/2024/02/google-meet-api-now-generally-available.html)
- CASA Tier 2: community thread reports Google negotiated a discounted Tier 2 rate with TAC Security, public price USD 540 per year (snippet) , [Google Apps Script community: Casa verification](https://groups.google.com/g/google-apps-script-community/c/XgsHT2Fr7u8); other unofficial estimates ~USD 550+, 2-6 weeks , [vet-docs CASA explanation (third-party)](https://vet-docs.pages.dev/docs/explanation-casa); vendor-site claim of USD 15k-75k on a "legacy track" is from a vendor selling verification services, treat as unreliable , [Unipile](https://www.unipile.com/integrating-google-oauth-2-0-user-authentication-into-your-app/)
- Tier 2 is mandatory for restricted scopes; sensitive-only scopes do not need CASA; CASA and verification renew annually (third-party) , [Nango: Google security review](https://nango.dev/docs/api-integrations/google-shared/google-security-review)

#### Inferences
- With the Media API gone after 2027-01-15, the only official Google Meet route for Ludy is after-meeting: Calendar to discover meetings, Meet REST API to fetch the transcript/smart notes the organizer's paid Workspace edition produced. Real-time notes on Meet would need a bot (not an official API) or the user's own browser/device capture.
- Meet add-ons are useful for a UI (show Ludy's action items, link the deal/task) inside Meet, not for capture.
- Whether Meet REST transcript scopes are "sensitive" or "restricted" decides whether CASA (annual cost) applies; I could not verify the classification.

#### Gaps
- Exact OAuth classification of Meet REST API scopes (e.g. `meetings.space.readonly`) and of Drive scopes needed to download transcript Docs/recordings: not verified.
- Google Calendar API scopes and their sensitivity for meeting discovery: not researched (budget).
- Workspace Marketplace listing requirements and review time: not found.
- Edition requirement for smart notes ("take notes for me", Gemini) specifically: not found.
- Any Google-named replacement for the Media API: none found.
- Whether smartNotes resources are now GA: not confirmed.

### Microsoft: Teams meeting apps, Graph transcripts/recordings (licensing, metered cost, admin consent, new tenant switch), real-time media bots, Copilot/agent routes, calendar

#### Takeaway
After-meeting Graph transcript and recording APIs are the practical Teams route: metered at USD 0.0022/min (transcript) and 0.003/min (recording) with 600 free minutes per app per tenant per month, need admin consent plus (since mid-2026) a tenant-level "Graph transcript access" switch that is off by default. Real-time media bots remain C#/.NET on Windows Server with public IP per VM. A new roadmap item (RM570651, "Work IQ: Real Time Transcripts", preview Sept 2026, GA Nov 2026) promises real-time transcript access for apps and agents, which may become the low-cost live route.

#### Cited Findings
Graph transcripts and recordings
- Transcript/recording APIs are metered; current rates USD 0.003/min recording, USD 0.0022/min transcript, duration rounded down to whole minutes (snippet of Microsoft Learn) , [Microsoft Learn: Payment models and licensing requirements for Teams APIs](https://learn.microsoft.com/en-us/graph/teams-licenses)
- Evaluation quota: 600 minutes per app per tenant per month without Azure billing; resets monthly, no carry-over (snippet) , same source
- No active Azure billing subscription returns HTTP 402; these APIs are outside model A/B payment models and usable by any app regardless of use case (snippet) , same source
- Original 2023 rates were USD 0.03/min recording and 0.024/min transcript (2023-09); lowered from 2024-01-01 , [Microsoft 365 Dev blog 2023-09-11](https://devblogs.microsoft.com/microsoft365dev/microsoft-teams-recording-and-transcript-apis-billing-in-public-preview/); [The Register 2023-09-04](https://www.theregister.com/2023/09/04/microsoft_teams_api_billing/)
- Transcript APIs GA 2023-10-31 , [Microsoft 365 Dev blog](https://devblogs.microsoft.com/microsoft365dev/microsoft-graph-apis-for-microsoft-teams-meeting-transcripts-now-generally-available/)
- Apps can use org-wide application permissions or RSC application permissions; app-level access needs admin consent and an application access policy; permission `OnlineMeetingTranscript.Read.All` (snippet) , [Microsoft Learn: Teams meeting transcripts overview](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/meeting-transcripts/overview-transcripts)
- MC1393806 (posted 2026-06-16/17): new Teams admin center controls (and PowerShell) to allow/block apps and agents reading meeting transcripts via Graph, plus a separate speaker-attribution switch; Graph access off by default; switch does not grant access to apps lacking Graph permissions; from about 2026-07-29 Graph permissions alone are not enough (third-party summaries, dates vary) , [mc.merill.net MC1393806](https://mc.merill.net/message/MC1393806); [Topedia 2026-07](https://blog-en.topedia.com/2026/07/new-tenant-control-for-graph-api-access-to-teams-transcripts-will-be-enforced-soon/); [Decisions support](https://support.meetingdecisions.com/en/how-to-enable-graph-api-transcripts)
- Cmdlet named by one vendor: `Set-CsTeamsMeetingConfiguration -EnableGraphTranscriptAccess` (unverified) , [o365reports](https://o365reports.com/how-to-manage-teams-transcript-api-access-for-meetings/)
- Microsoft Q&A (Aug 2026): Graph transcript access stopped working after the July policy change despite an application access policy; fix was the tenant transcript setting (accepted answer marked AI-generated) , [Microsoft Q&A 5965856](https://learn.microsoft.com/en-us/answers/questions/5965856/graph-api-access-to-transcripts-stopped-working-af)
- Tony Redmond's 2026-09-21 how-to on Graph transcript access (not opened) , [office365itpros](https://office365itpros.com/2026/09/21/teams-meeting-graph-api/)
- Reports of `adhocCalls` transcripts returning 501 and getAllTranscripts returning empty arrays (community) , [Microsoft Q&A 5708817](https://learn.microsoft.com/en-us/answers/questions/5708817/microsoft-graph-api-adhoccalls-transcripts-returns)

Real-time media bots
- Application-hosted media bots: C#/.NET and Windows Server (or Windows Server guest OS); `Microsoft.Graph.Communications.Calls.Media` library, .NET 6 supported; bot directly reachable on the internet with an instance-level public IP and a public port per VM; a call's media is pinned to one VM (snippets) , [Microsoft Learn: Requirements for application-hosted media bots](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/requirements-considerations-application-hosted-media-bots)
- The page carried a note that the Real-time Media Platform for bots is in developer preview; current status in Nov 2026 not confirmed (snippet) , same source
- `Calls.AccessMedia.All` gives direct media access without a signed-in user; application permissions need admin consent (snippet; third-party guide pairs it with `Calls.Initiate.All`; joining meetings uses `Calls.JoinGroupCall.All` per the design record, not re-verified) , same source; [ElevenLabs: Graph media bot guide](https://elevenlabs.io/docs/eleven-agents/phone-numbers/microsoft-teams/graph-media-bot)
- Marketplace media-bot apps must be multi-tenant and admin-consentable (Microsoft Q&A, Jan 2026, community) , [Tech Community discussion 4489265](https://techcommunity.microsoft.com/discussions/teamsdeveloper/how-to-create-an-audio-calling-bot-for-the-marketplace/4489265)
- Correction to the design record: Microsoft docs say Windows Server, not strictly "on Azure"; Azure is the common host but the snippet requirement is Windows Server with public IP per instance.

Copilot / agent routes and meeting apps
- RM570651 "Work IQ: Real Time Transcripts": lets apps and agents read Teams meeting transcripts while the meeting runs; preview September CY2026, GA November CY2026; published 2026-10-19 (aggregator of the M365 Roadmap) , [mc.merill.net RM570651](https://mc.merill.net/message/RM570651); [handsontek](https://m365admin.handsontek.net/?p=25120)
- MC1319216: in-meeting toggle lets licensed organizers/presenters turn Meeting AI on/off; turning it off also disables recording and transcription; rollout mid-June vs mid-September 2026 (sources disagree) , [itelio MC1319216](https://www.itelio.com/en/microsoft-message-center/mc1319216)
- Meeting apps can be scoped to a meeting and appear as side panel, tabs or main stage, and react to Graph meeting lifecycle events (2025, third-party) , [m365.fm 2025-08-13](https://www.m365.fm/advanced-teams-meeting-extensibility-with-apps-bots/)

#### Inferences
- For an SME on Microsoft 365, the after-meeting Graph route costs about USD 0.13 per transcribed hour (0.0022 x 60) beyond the free 600 min/app/tenant/month, which likely covers a small SME entirely; but onboarding needs a tenant admin to consent and to turn on the new Graph transcript access switch, a real friction step for a one-person company.
- Self-hosted Ludy would need each operator's own Entra app registration plus an Azure billing subscription past the free quota; Crove Cloud could hold one multi-tenant app.
- RM570651 may make real-time Teams notes possible without a Windows media bot; watch for the official Graph docs before building.
- A C#/Windows media bot conflicts with Ludy's `docker compose up` Linux stack and small team; low value.

#### Gaps
- Official documentation of the RM570651 real-time transcript API (endpoint, permissions, pricing): not found; only roadmap aggregators.
- Teams Store (AppSource) app validation / Microsoft 365 Certification requirements and timeline for a meeting app: not researched.
- Graph calendar (`Calendars.Read`) consent friction for meeting discovery: not researched.
- Whether transcripts require the meeting organizer to hold a particular Teams/M365 license (e.g. Teams Premium) for Graph access: not confirmed.
- Current preview/GA status of the real-time media platform for bots.

### Which route gives the best value for an SME-focused product with a small team

#### Takeaway
Best value: after-meeting ingestion on all three (Zoom cloud recording transcript + webhooks, Google Meet REST API transcripts/smart notes, Microsoft Graph transcripts), plus one live route only where it is official and cheap: Zoom RTMS. Skip bots (Zoom OBF-bound, Teams Windows media bots, Google Media API shut 2027-01-15).

#### Cited Findings
- Google Media API shuts 2027-01-15; REST API and add-ons SDK unaffected , [Meet REST API release notes](https://developers.google.com/workspace/meet/release-notes)
- Teams transcript API USD 0.0022/min, 600 free min/app/tenant/month , [Microsoft Learn teams-licenses](https://learn.microsoft.com/en-us/graph/teams-licenses)
- Zoom RTMS billed per minute from Developer Pack credits, no trial , [devforum 143811](https://devforum.zoom.us/t/rtms-feature-annual-fee/143811); [devforum 144191](https://devforum.zoom.us/t/request-to-enable-rtms-for-my-zoom-pro-account/144191)
- Zoom OBF bots must leave when their owner leaves , [Zoom docs: OBF](https://developers.zoom.us/docs/meeting-sdk/auth/obf/)
- Teams media bots require Windows Server/.NET and public IP per VM , [Microsoft Learn](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/requirements-considerations-application-hosted-media-bots)

#### Inferences
- Rank for Ludy (small team, Linux, self-hostable, Vietnam SMEs who often use free Zoom/Meet): (1) a "bring your own recording/transcript" path that works with AI off and no platform approval (upload audio or paste transcript; outside this note's scope); (2) Google Meet REST + Calendar after-meeting, but only for customers on paid Workspace editions, and check CASA exposure; (3) Zoom cloud-recording transcript webhooks (needs App Review for external accounts; customer needs cloud recording); (4) Microsoft Graph transcripts (cheap, but tenant admin consent + new transcript switch); (5) Zoom RTMS for live notes, once billing ownership is clear; (6) watch Teams RM570651. Avoid bots.
- Every published-app route (Zoom App Review, Google OAuth verification/CASA, Microsoft multi-tenant admin consent) fits Crove Cloud's hosted app better than self-hosters, who would each need their own app registration; this argues for keeping platform connectors optional.

#### Gaps
- Real SME adoption of paid Workspace/Zoom plans in Vietnam (determines how many customers can use after-meeting APIs): not researched.
- Exact end-to-end approval time per platform: no official SLAs found.

## Notes: other_routes


Research date: 2026-11-14. Method: web search (about 24 queries). Direct page fetches were blocked in this session for api.slack.com, mini.zalo.me and developer.chrome.com (host outside the session's allowed network domains), so most Slack, Zalo and Chrome claims come from search-result snippets of official pages, not full reads. A fetch of developer.apple.com returned only the page title, so nothing below is cited to that page's body. Each claim carries its source; items found only in third-party or low-authority sources are marked as such.

### Zalo: OA API, ZNS, Mini App, calls, login

#### Takeaway
Zalo's usable routes for a notes vendor are output and identity: OA messages (a free-form "consultation" message only within 48 hours of the user's last interaction), ZNS template messages (pre-approved templates, paid per successful send, roughly 250 to 360 VND each per one partner's price sheet) and Zalo Login (OAuth v4 with PKCE). I found no public API for Zalo calls or group calls and no Zalo Mini App audio-recording API, so Zalo cannot be a capture source. Official Zalo pages could not be opened and no official ZNS rate card turned up, so the prices need confirming in the zalo.cloud console.

#### Cited Findings
- ZNS messages must use templates pre-approved by Zalo, max 400 characters. , [Infobip Zalo message types](https://www.infobip.com/docs/zalo/message-types.md) (no date)
- ZNS lets a business send system notifications to users who have interacted with its Official Account; templates are approved by Zalo before sending; fees are charged per template. , [eSMS help: Zalo OA](https://helpcenter.esms.vn/cau-hoi-thuong-gap/zalo-oa) (undated); [AdFlex ZNS docs](https://docs-zns.adflex.vn/index.md) (undated)
- Price points from one partner's API doc: a successful ZNS Template send costs 360 VND if "Ztime" <= 15 s and 250 VND if Ztime <= 7,200 s; a CTA button linking to a web page or hotline adds 100 VND per type. The date of these prices is not stated. , [nhanh.vn POS manual, OA message types](https://pos.manual.nhanh.vn/pos/cai-dat/gui-zalo-zns/cac-loai-tin-cua-oa)
- An older figure, "from 120 VND per successful send", appears in a different (older) context; do not use it as the current price. , [EGANY recap](https://egany.com/ecommerce-cro/recap-ega-cafe-8-giai-phap-zalo-business-cho-doanh-nghiep) (undated)
- AdFlex: each successful ZNS request creates a real message and deducts the template price from the workspace wallet; there is no sandbox environment. , [AdFlex ZNS docs](https://docs-zns.adflex.vn/index.md)
- A new Zalo OA is capped at 5,000 messages/day and cannot send ZNS "Tag 3" (post-sale/marketing-adjacent) messages; quota rises in stages. , [Brands Vietnam, ZNS Tag 3 roadmap](https://www.brandsvietnam.com/congdong/topic/lo-trinh-trien-khai-tin-zns-tag-3-tu-cham-soc-khach-hang-den-tang-truong-doanh-thu-hau-mai); staged quota: [nhanh.vn manual](https://pos.manual.nhanh.vn/pos/cai-dat/gui-zalo-zns/cac-loai-tin-cua-oa)
- OA "consultation" (tư vấn) messages go through `https://openapi.zalo.me/v3.0/oa/message/cs` and may only be sent within 48 hours of the user's last interaction with the OA. , unofficial SDK doc: [redai-zalo-sdk CONSULTATION_SERVICE.md](https://unpkg.com/@warriorteam/redai-zalo-sdk@1.11.1/docs/CONSULTATION_SERVICE.md)
- OA consultation-message fees: one reseller cites "0-50 VND per successful send, charged from the 1,001st message" (undated). , [eSMS help: Zalo OA](https://helpcenter.esms.vn/cau-hoi-thuong-gap/zalo-oa). One free broadcast per follower per month (updated 2025-11-18). , [ViettelStore: is Zalo OA free](https://viettelstore.vn/tin-tuc/zalo-oa-co-mat-phi-khong)
- Zalo Login: authorization endpoint `https://oauth.zaloapp.com/v4/permission`, token endpoint `https://oauth.zaloapp.com/v4/access_token` (third-party listing). , [Logto OAuth providers explorer: Zalo](https://logto.io/oauth-providers-explorer/zalo)
- An Odoo Zalo SSO connector uses PKCE (S256), avoids deprecated v2 calls, sends the app secret as a `secret_key` header at token exchange, and gets the profile fields id, name and picture. , [Odoo app store, zalo_sso](https://apps.odoo.com/apps/modules/19.0/zalo_sso)

#### Inferences
- Zalo fits Ludy as an output channel: a ZNS template such as "Biên bản họp [tên] đã sẵn sàng, xem tại [link]" to people who follow the business's OA, or a free-form OA message inside the 48 h window. The notes themselves would live behind a Ludy link, since templates are fixed text with parameters and capped at 400 characters.
- ZNS is per-business: each Ludy customer would need its own OA (and a business-verified OA for higher quotas) and template approval, or Ludy sends from one Ludy OA. A self-hosted install can only offer "bring your own OA and ZNS account".
- Since ZNS bills per send from a prepaid wallet with no sandbox, sends belong behind the human approval and spend meter that AGENTS.md requires for messages and spend.
- Zalo Login is a reasonable "sign in with Zalo" for Vietnamese OPCs, but the profile is thin (id, name, picture, per the Odoo connector); no email is listed.

#### Gaps
- Official ZNS rate card (zalo.cloud) and per-tag pricing (Tag 1/2/3, OTP) for 2026: not found; mini.zalo.me and developers.zalo.me could not be fetched.
- Zalo Mini App platform: I found no Zalo source on zmp-sdk APIs for microphone or audio recording, nor on the Mini App review process. Whether a Mini App may record audio is unverified. (Other host platforms' mini apps show host-level mic gating, for example [Shopify community](https://community.shopify.dev/t/microphone-implementation-issues/26787), but that says nothing about Zalo.)
- Zalo calls and group calls: no public API found in any search. "No API exists" is an inference from silence, not a confirmed statement.
- The OA's own API access (whether the OA API needs a paid OA package in 2026) was not confirmed from an official source.

### Slack: posting, Marketplace review, 2025 API terms and rate limits, huddles

#### Takeaway
Posting summaries and action items to channels (chat.postMessage, Block Kit) is unaffected by the 2025 changes. Reading channel history is not: since 2025-05-29 a new commercially distributed non-Marketplace app gets `conversations.history`/`conversations.replies` at 1 request/minute and 15 messages per request, and existing installs lost their grace period on 2026-03-03. Marketplace listing removes that limit, but in July 2026 it began requiring 10 active workspace installs, and reviews have taken weeks to months. Slack exposes no huddle audio or transcript API.

#### Cited Findings
- For commercially distributed apps not approved for the Slack Marketplace, `conversations.history` and `conversations.replies` moved to 1 request/minute, with the `limit` max and default cut to 15 objects. , [Slack changelog 2025-05-29](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps); [conversations.history reference](https://docs.slack.dev/reference/methods/conversations.history.md)
- New non-Marketplace apps and new installs of existing ones were subject to the limits from 2025-05-29; existing installs were first exempt until 2025-09-02, a date later moved to 2026-03-03 (shown as a strikethrough on Slack's FAQ). , [Slack FAQ: 2025-05 terms and rate limit update](https://api.slack.com/changelog/2025-05-terms-rate-limit-update-and-faq) (search snippet only; page fetch blocked)
- Marketplace apps and internal customer-built apps are not affected; for custom (internal) apps, these methods allow 50+ requests/minute and a 1,000-object limit. , same FAQ; [Slack rate limits](https://docs.slack.dev/apis/web-api/rate-limits)
- The same May 2025 update changed the API terms on data use. The full text could not be fetched; Dust's notes summarise its impact on AI tools. , [Dust: Slack Terms of Service update and API changes](https://dust-tt.notion.site/Slack-Terms-of-Service-update-and-API-Changes-21728599d94180f3b2b4e892e6d20af6) (last updated July 23, year implied 2025)
- Marketplace submission requires at least 10 installs on active workspaces as of July 2026 (Slack changelog); a May 2026 Slack blog post had said 5. , [Slack changelog 2026-09-01: Marketplace install requirement](https://docs.slack.dev/changelog/2026/09/01/slack-marketplace-install-requirement); conflict noted by search; also [Slack platform newsletter June 2026](https://slack.dev/newsletter/platform-newsletter-june-2026/)
- Review has a preliminary readiness check and a functional stage; resubmitting resets your queue position; Slack reviews at a moment in time and does no code review; scopes are judged on least privilege; after approval, changes to configuration, features or scopes need resubmission. , [Slack Marketplace review guide](https://docs.slack.dev/slack-marketplace/slack-marketplace-review-guide); [Marketplace guidelines and requirements](https://docs.slack.dev/slack-marketplace/slack-marketplace-app-guidelines-and-requirements/); [Slack: less is more on scopes](https://slack.dev/scoping-your-app-for-the-slack-marketplace/)
- Review duration, anecdotal: one vendor says 2-3 months typical (theirs took two weeks); one developer reports roughly four months (first commit October 2025, public May 2026). , [viktor.com blog](https://viktor.com/blog/slack-marketplace-ai-agent); [levelup.gitconnected.com](https://levelup.gitconnected.com/how-i-published-my-own-app-in-the-slack-marketplace-and-what-the-docs-didnt-tell-me-776e365d0426)
- Huddles: Slack's official APIs give no access to huddle recordings, transcripts or metadata (vendor claim); Recall.ai offers a "Slack Huddles API" through its Desktop Recording SDK, i.e. desktop-side capture, not a Slack API. , [Recall.ai Slack Huddles API](https://www.recall.ai/product/slack-huddles-api); [Recall.ai blog](https://www.recall.ai/blog/get-recordings-and-transcripts-from-slack-huddles-api)

#### Inferences
- An output-only Slack integration (post the summary and action items to a chosen channel, maybe with buttons) needs no history reads, so the 1 rpm limit does not bite. Self-hosted Ludy can let each customer create its own internal ("custom") Slack app, which keeps the full limits and needs no Marketplace review.
- Ludy Cloud distributing one app to many workspaces is "commercially distributed": fine for posting, throttled for reading history. Marketplace listing is a later step, gated on 10 active installs.
- Huddle capture is the same problem as any desktop call: it needs the desktop app (system audio) route below. The Chrome extension can capture a huddle only if the user runs Slack in a browser tab (inference, untested).

#### Gaps
- Full text of the May 2025 API Terms (exact wording on bulk export, data storage and LLM training) could not be opened; verify on the Slack site.
- No Slack-authored page confirming "no huddle API" was retrieved; only vendors say it.
- chat.postMessage's own rate tier was not re-checked (commonly about 1 message/second per channel; unverified here).

### Calendar: Google Calendar and Microsoft Graph

#### Takeaway
Google Calendar read scopes are "sensitive" (not "restricted"): public use needs OAuth app verification (demo video, privacy policy on the app's domain, narrowest scope) but no paid security assessment. On Microsoft Graph, delegated `Calendars.Read` normally needs no admin consent, but a third-party admin guide reports that since November 2025 Entra ID's default requires admin consent for third-party apps' calendar access, and publisher verification is expected for multitenant apps.

#### Cited Findings
- Google gives "read events stored in Google Calendar" as an example of a sensitive scope; apps requesting sensitive or restricted scopes must complete verification unless an exception applies. , [Google: sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)
- Verification needs a video showing how a user grants access and how each sensitive scope is used, plus a privacy policy hosted on the same domain as the app's home page and linked from the consent screen. Google expects the narrowest scope (read-only when only reading). , same page
- Sensitive-scope verification "typically takes 3-5 business days" (search-summary figure; not confirmed on the page). Workspace admins may block sensitive scopes for OAuth clients they have not marked trusted. , same page (snippet)
- Calendar scopes need sensitive verification only, no security assessment (third-party provider guide). , [Nylas: Google verification and security assessment guide](https://developer.nylas.com/docs/provider-guides/google/google-verification-security-assessment-guide/)
- Graph delegated `Calendars.Read`: admin consent not required by default. , [graphpermissions.merill.net: Calendars.Read](https://graphpermissions.merill.net/permission/Calendars.Read)
- In November 2025 Microsoft changed Entra ID defaults so that all third-party apps need administrator consent before users can grant calendar access (third-party admin guide; not confirmed on Microsoft Learn). , [CalendarBridge admin docs](https://help.calendarbridge.com/group-admin-docs/approve-delegated-permissions-for-calendarbridge-for-microsoft-365/)
- Tenant policy can require admin consent even for scopes that normally don't need it. , [Microsoft Q&A](https://learn.microsoft.com/en-us/answers/a/12308694)
- Publisher verification has been required for multitenant apps since November 2020; without it users see an error (third-party claim). , [Nylas: create Microsoft calendar events](https://developer.nylas.com/docs/cookbook/calendar/events/create-events-microsoft.md)
- `onlineMeeting` objects need `OnlineMeetings.Read`, which is not supported for personal Microsoft accounts. , [Graph onlineMeeting get (beta)](https://learn.microsoft.com/sv-se/graph/api/onlinemeeting-get?view=graph-rest-beta)

#### Inferences
- With `calendar.events.readonly` (Google) and `Calendars.Read` (Graph), Ludy can list upcoming meetings, read the Meet/Teams/Zoom link to offer "capture this meeting" in the extension, and match a capture to an event. Writing notes back (event description or attachment) needs a write scope (`calendar.events`, `Calendars.ReadWrite`), which widens the verification demo.
- Self-hosted installs must register their own Google and Entra OAuth clients; Google's "unverified app" screen and user caps apply until verified. Ludy Cloud should verify one Google client and one publisher-verified Entra app.
- For an SME on Microsoft 365, expect an admin-consent step in onboarding.

#### Gaps
- The exact sensitivity tier of `calendar.events.readonly` and the current Google unverified-app user cap were not confirmed on Google's scope list.
- Microsoft Learn confirmation of the November 2025 consent default and of publisher-verification rules was not retrieved.

### Browser extensions: Chrome Web Store, Edge Add-ons, Firefox, Safari

#### Takeaway
On Chrome, MV3 tab audio capture is supported: since Chrome 116 the service worker gets a stream ID from `chrome.tabCapture` and an offscreen document (reason `USER_MEDIA`) records it. The 2026 Chrome Web Store update (enforced from 2026-08-01) tightened Limited Use and prominent disclosure: any data collected must be strictly necessary to the extension's single disclosed purpose, and all collection must be disclosed prominently. Firefox has no `tabCapture` and its `getDisplayMedia` lacks audio, so tab audio is effectively Chromium-only. No Safari route was found.

#### Cited Findings
- Chrome 116+: `tabCapture` can be called from the service worker, and the stream ID passed to an offscreen document that records; stream IDs are single-use and expire after a few seconds; capture from a popup stops when the popup closes. , [Chrome: audio recording and screen capture](https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture.md.txt) (snippet)
- Recording from an offscreen document (not a content script) avoids muting the tab for the user; connecting the source to the output keeps tab audio audible (Chrome DevRel reply plus a developer report). , [chromium-extensions group thread](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/JI7AW48PxGs/m/QZ69ZIx1AgAJ)
- Reference implementation of this pattern for meeting recording: , [recallai/chrome-recording-transcription-extension](https://github.com/recallai/chrome-recording-transcription-extension)
- Chrome Web Store 2026 policy update: user data collected must be strictly necessary to the disclosed single purpose; all data collection must be prominently disclosed; enforcement began 2026-08-01; it also bans tools that bypass AI providers' limits. , [Chrome blog: CWS policy updates 2026](https://developer.chrome.com/blog/cws-policy-updates-2026) (published 2026-07-01 per search; fetch blocked); [CyberInsider](https://cyberinsider.com/google-chrome-extensions-must-meet-new-privacy-standards-by-august-1/); [Android Authority](https://www.androidauthority.com/chrome-web-store-extension-stricter-rules-3684115/)
- A common rejection is "Excessive permissions": requesting a permission the extension does not use. , [CWS troubleshooting](https://developer.chrome.com/docs/webstore/troubleshooting.md.txt)
- Firefox: the `tabCapture` WebExtensions API is not implemented (long-open bug); `getDisplayMedia` on Firefox lacks audio capture. , [Bugzilla 1391223](https://bugzilla.mozilla.org/show_bug.cgi?id=1391223); [Bugzilla 1443484](https://bugzilla.mozilla.org/show_bug.cgi?id=1443484)
- Some Firefox add-ons nevertheless record tab audio (method not established, probably Web Audio on page media elements). , [AMO: Tab Audio Recorder](https://addons.mozilla.org/firefox/addon/tab-audio-rec/)

#### Inferences
- Ludy's existing MV3 extension is on the supported path. To pass the 2026 rules it should: request only `tabCapture`, `offscreen` and the narrowest host permissions; show an in-product disclosure before the first capture; publish a privacy policy that names audio, transcripts and where they are processed (self-hosted vs Ludy Cloud); keep one stated purpose (meeting capture and notes).
- Edge Add-ons runs the same Chromium extension APIs, so the same package should work, but its store review was not researched (see gaps).
- Firefox and Safari users need the desktop app route or in-meeting microphone-only capture.

#### Gaps
- Microsoft Edge Add-ons policy text and review times: not retrieved (learn.microsoft.com Edge pages not reached by search).
- Safari Web Extensions: no source found on tab audio capture; treat as unsupported until verified.
- Chrome Web Store's specific treatment of `tabCapture` (justification text, extra review time) was not found.

### Desktop apps: bot-free system audio capture, signing, consent

#### Takeaway
Bot-free notes apps such as Granola run on the user's computer and mix microphone plus system audio: Core Audio on macOS and WASAPI on Windows. macOS needs the "Screen & System Audio Recording" and Microphone permissions (Core Audio process taps, with an audio-capture usage string, report a denied permission only as silent buffers); ScreenCaptureKit apps also see Sequoia's periodic re-approval prompts. Windows needs no prompt for system audio, and since Windows 10 2004 WASAPI "process loopback" can capture a single app's process tree. Signing costs: Apple Developer Program (commonly USD 99/year, not verified here) for Developer ID and notarization; Azure Artifact Signing about USD 9.99/month, but only offered in the USA, Canada and Europe.

#### Cited Findings
- Granola: no meeting bot; it runs only on the user's computer using system audio and microphone; Core Audio on macOS, WASAPI on Windows; it cannot capture calls the user is not on. , [Granola docs: transcription](https://docs.granola.ai/article/transcription); [Granola for Windows](https://www.granola.ai/blog/granola-for-windows-setup-teams-and-zoom-capture-and-what-it-controls)
- Granola macOS permissions: Microphone plus System Settings > Privacy & Security > "Screen & System Audio Recording", used only for system audio, no video saved; on Windows audio permissions are granted automatically, with "Let desktop apps access your microphone" on. Missing permissions are the usual cause of silent transcripts; Bluetooth and non-default devices cause problems. , [Granola docs: transcription issues](https://docs.granola.ai/article/transcription-issues); [Granola free trial guide](https://www.granola.ai/blog/granola-free-trial-get-started)
- Core Audio taps (macOS 14.4+ per the open-source AudioCap sample) capture other apps' or system audio after a user permission prompt; there is no public API to request or check that permission. , [insidegui/AudioCap](https://github.com/insidegui/AudioCap); [ecosyste.ms summary](https://awesome.ecosyste.ms/projects/github.com%2Finsidegui%2Faudiocap)
- When permission is denied, Core Audio calls still return noErr and buffers are zeros (developer report). , [DEV: 2000 buffers of nothing](https://dev.to/nickdelv/2000-buffers-of-nothing-3i8)
- macOS Sequoia (2024): the screen-recording re-approval prompt moved from weekly to monthly during beta and applies to ScreenCaptureKit apps; macOS 15.1 reduced it further for regularly used apps. , [9to5Mac, 2024-08-14](https://9to5mac.com/2024/08/14/macos-sequoia-screen-recording-prompt-monthly/); [TidBITS, 2024-08-19](https://tidbits.com/2024/08/19/apple-reduces-excessive-sequoia-permission-requests-shifts-to-monthly); [iDownloadBlog on 15.1](https://www.idownloadblog.com/?p=1015276)
- Windows: `ActivateAudioInterfaceAsync` with `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` captures audio from one process tree (include mode) or everything except it (exclude mode); a target with no render streams yields silence. , [Microsoft ApplicationLoopback sample](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/); [PROCESS_LOOPBACK_MODE](https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ne-audioclientactivationparams-process_loopback_mode)
- Minimum Windows version conflict: a third-party package says Windows 10 2004 (build 19041); Microsoft's enum page lists build 20348. , [process-audio-capture on PyPI](https://pypi.org/project/process-audio-capture/); contradicted by [AUDIOCLIENT_ACTIVATION_TYPE](https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ne-audioclientactivationparams-audioclient_activation_type)
- Azure Artifact Signing (formerly Trusted Signing): Basic about USD 9.99/month for 5,000 signatures and 1 certificate profile; Premium about USD 99.99/month for 100,000 signatures and 10 profiles; generally available in the USA, Canada and Europe (DevClass, 2026-01-14). Microsoft's pricing page lists the same quotas, but its prices did not render; billing starts when the account is created. , [DevClass](https://www.devclass.com/security/2026/01/14/code-signing-windows-apps-may-be-easier-and-more-secure-with-new-azure-artifact-service/4079554); [Azure pricing](https://azure.microsoft.com/pricing/details/artifact-signing/)
- Recall.ai's "Desktop Recording SDK" is the commercial equivalent for capturing desktop meetings (Zoom, Teams, Slack huddles) without a bot. , [Recall.ai Slack Huddles API](https://www.recall.ai/product/slack-huddles-api)

#### Inferences
- A Ludy desktop app (e.g. Tauri/Electron plus a native audio module) is the only route that covers Zalo PC calls, Slack huddles, Teams/Zoom desktop clients and Firefox/Safari users. It is also the biggest build: two native audio stacks, signing, notarization and auto-update.
- Process-level capture (Core Audio process tap on a PID, WASAPI process loopback) lets Ludy capture only the meeting app (for example Zalo PC) rather than all system sound, a better privacy default.
- Azure Artifact Signing's region limit may exclude a Vietnamese legal entity; a traditional OV/EV certificate from a CA would then be needed (price not researched).
- Consent: bot-free capture is invisible to other participants (no bot joins), so the app should prompt the user to announce recording and could post a consent line into the meeting chat. This matters under Vietnamese law (below).

#### Gaps
- Apple's "Capturing system audio with Core Audio taps" page could not be read (fetch returned the title only). The exact minimum macOS (14.2 vs 14.4), Info.plist key (believed `NSAudioCaptureUsageDescription`) and entitlements are unconfirmed.
- Apple Developer Program fee (widely known as USD 99/year) and notarization requirements: not confirmed by a source in this session.
- Krisp's and Jamie's capture methods were not researched; only Granola's.
- Prices of traditional Windows OV/EV code-signing certificates were not researched, and whether Azure Artifact Signing accepts organizations outside its listed regions was not confirmed.

### Mobile: in-person meeting recording (iOS/Android)

#### Takeaway
On iOS, an app that starts a recording session in the foreground may keep recording in the background (Apple DTS forum answer), but App Review often rejects under Guideline 2.5.4 when reviewers cannot find the feature. Recording without consent is a separate risk under 2.5.14. Android rules were not researched.

#### Cited Findings
- Apple engineer (forums): apps that start an audio recording session in the foreground may keep recording indefinitely in the background; recording without the user's consent may violate Guideline 2.5.14. , [Apple Developer Forums 776949](https://developer.apple.com/forums/thread/776949)
- Guideline 2.5.4 limits background services to their intended purposes (VoIP, audio playback, location, task completion, local notifications and similar). , [ConductAtlas summary of guidelines](https://conductatlas.com/platform/apple/apple-app-store-review-guidelines/provision/CA-P-018863/multitasking-background-services-limited-to-intended-purposes/) (secondary)
- Developers report repeated 2.5.4 rejections even with clear UI, onboarding and a video; the advice is to state the user-visible background-recording feature in review notes and offer a switch to turn background recording off. , [Apple Developer Forums 826849](https://developer.apple.com/forums/thread/826849); [Apple Developer Forums 91872](https://developer.apple.com/forums/thread/91872)
- The orange microphone indicator shows while an iOS app records in the background (developer report). , [Apple Developer Forums 776949](https://developer.apple.com/forums/thread/776949)

#### Inferences
- An installable PWA (part of the Ludy web app) can record in the foreground with no store review; a native iOS app is needed for reliable screen-off recording, and it carries the review risk above.

#### Gaps
- Android: foreground-service type `microphone` rules (Android 14+) and Google Play's policy on recording apps were not researched.
- Current App Review Guidelines text (2.5.4, 2.5.14) was not read directly.

### Messaging and email outputs (email, Teams, Slack, Zalo)

#### Takeaway
Output routes are the cheap, low-review part: email (SMTP the customer already has), Slack chat.postMessage (unaffected by the 2025 read limits), Zalo OA or ZNS (paid, template-approved), and Teams through Workflows (Power Automate) webhooks, since Office 365 Connectors in Teams were switched off in May 2026.

#### Cited Findings
- Office 365 Connectors in Teams were to be disabled 2026-05-18 to 22 (Message Center MC1181996); a third-party IT blog reports the shutdown finished 2026-05-22. Replacement: Workflows (Power Automate) webhooks, using templates that need no premium licence. , [MC1181996 on mc.merill.net](https://mc.merill.net/message/MC1181996); [Infonaligy](https://www.infonaligy.com/blog/teams-connectors-retired-fix-broken-workflows); [o365reports](https://o365reports.com/office-365-connectors-retirement-in-teams-and-migration-to-workflows/)
- As of April 2026, Workflows webhook cards in private channels were planned, not available. , [Microsoft Q&A 5854971](https://learn.microsoft.com/en-us/answers/questions/5854971/will-teams-incoming-webhooks-stop-delivering-alert)
- Slack and Zalo output facts: see the Slack and Zalo sections above.

#### Inferences
- The lowest-effort Teams route is "paste your Workflows webhook URL" in Ludy settings (works self-hosted, no Microsoft app registration); a full Teams bot app is a larger, separate project.
- Every outbound message (email, Slack, Teams, Zalo) should go through a person's approval, per Ludy's rule that a person approves messages and spend.

#### Gaps
- Email deliverability requirements (SPF/DKIM/DMARC for bulk senders) were not researched for this note.

### Vietnamese legal context: consent to record, personal data

#### Takeaway
From 2026-01-01 the Personal Data Protection Law (Law 91/2025/QH15) and its Decree 356/2025/ND-CP apply; Decree 356 replaced Decree 13/2023/ND-CP. Consent must be informed and freely given and may be given by voice, recorded call, email or website. Article 29(5) bars social-media and online-communication providers from recording users' calls without consent. Secondary sources describe Civil Code Article 38 (privacy) and Penal Code Article 159 (secrecy of communications) as further risk for covert recording, but I could not confirm their text.

#### Cited Findings
- Law 91/2025/QH15, passed 2025-06-26, effective 2026-01-01. , [VnEconomy](https://vneconomy.vn/nhung-diem-moi-trong-luat-bao-ve-du-lieu-ca-nhan-tu-112026.htm); [Báo Văn hóa](https://baovanhoa.vn/nhip-song-so/tu-112026-quyen-rieng-tu-so-duoc-bao-ve-194073.html)
- Decree 356/2025/ND-CP (issued 2025-12-31) details the law, replaces Decree 13/2023/ND-CP and takes effect 2026-01-01. , [EY Vietnam legal alert, March 2026](https://www.ey.com/content/dam/ey-unified-site/ey-com/vi-vn/technical/tax/documents/ey-vietnam-legal-alert-march-2026-decree-no356-2025-nd-cp-providing-detailed-guidance-for-implementation-of-personal-data-protection-law-viet.pdf); [Chambers](https://chambers.com/articles/new-legal-framework-on-personal-data-protection-in-vietnam)
- Decree 356 widens valid forms of consent, for example consent through a recorded call, email or a website. , [EY Vietnam, March 2026](https://www.ey.com/content/dam/ey-unified-site/ey-com/vi-vn/technical/tax/documents/ey-vietnam-legal-alert-march-2026-decree-no356-2025-nd-cp-providing-detailed-guidance-for-implementation-of-personal-data-protection-law-viet.pdf)
- Article 29(5): social-media and online-communication service providers must not wiretap, eavesdrop on or record calls, or read messages, without the user's consent unless another law permits. , [LuatVietnam English](https://english.luatvietnam.vn/legal-updates/social-media-platforms-must-not-eavesdrop-or-read-users-messages-without-consent-892-103040-article.html)
- Data-subject rights under the law include the rights to know, consent, access, correct and request deletion. , [VnEconomy](https://vneconomy.vn/nhung-diem-moi-trong-luat-bao-ve-du-lieu-ca-nhan-tu-112026.htm)
- Misuse of personal data can be fined up to 3 billion VND (headline). , [LSVN](https://lsvn.vn/su-dung-du-lieu-ca-nhan-sai-trai-co-the-bi-phat-den-03-ti-dong-a167866.html)
- Biometric data carries heightened duties (physical security, restricted access, notice on harm). , [G&V Lawyers, PDP Law alert, 2025-09](https://gvlawyers.com.vn/wp-content/uploads/2025/09/EN_Legal-alert-_Law-on-PDP-2025.pdf); [KPMG Vietnam, 2025-07](https://assets.kpmg.com/content/dam/kpmg/vn/pdf/2025/07/exploring-vietnam-personal-data-protection-law.pdf)
- Civil Code Article 38 (privacy) and Penal Code Article 159 (unlawful interception or recording of private communications), from a low-authority site, unverified. , [recording-law.vercel.app](https://recording-law.vercel.app/world-laws/world-recording-laws/vietnam-recording-laws/)

#### Inferences
- A meeting recording and its transcript contain personal data of every participant (voice, names, what they said), so the SME customer is a data controller and Ludy (Cloud) a processor. Ludy needs consent capture (a recorded verbal or written notice at the start), deletion, and a processing record.
- If Ludy Cloud counts as an "online communication service" under Article 29(5) (unclear), recording without consent is directly prohibited. The safe design is the same anyway: show a visible recording state, prompt the user to announce it, and log consent.
- Whether voice in a recording is "biometric" data (stricter rules) depends on whether it is used to identify speakers (voiceprint diarization). Speaker labels from the meeting platform avoid that question; voiceprint enrollment would raise it.

#### Gaps
- Primary texts of Law 91/2025 (Articles 9, 29), Decree 356/2025 (consent forms, sensitive-data list) and Civil Code Article 38 / Penal Code Article 159 were not read on thuvienphapluat.vn or chinhphu.vn; a Vietnamese lawyer should confirm before launch.
- Whether a voice recording or voiceprint is "sensitive" or "biometric" personal data under Decree 356 was not confirmed.
- Cross-border transfer rules (hosted cloud outside Vietnam, AI model calls to foreign endpoints) were not researched in this note.
