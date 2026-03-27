import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';

const CLOSER_EMAILS = [
  'giorgio@metana.io',
  'nicoleta@metana.io',
  'james@metana.io',
];

type Env = {
  CALL_REVIEW_WORKFLOW: Workflow;
  FIREFLIES_WEBHOOK_SECRET: string;
  FIREFLIES_API_KEY: string;
  HUBSPOT_ACCESS_TOKEN: string;
  SLACK_WEBHOOK_URL: string;
  SLACK_DISABLED?: string;
  AI: Ai;
  DB: D1Database;
  PLAYBOOK_KV: KVNamespace;
};

type WorkflowParams = {
  meetingId: string;
  title: string;
  participants: { name: string; email: string }[];
};

// ─── Helpers ────────────────────────────────────────────────────────────────

async function isAlreadyProcessed(db: D1Database, meetingId: string): Promise<boolean> {
  const row = await db.prepare(
    'SELECT meeting_id FROM processed_meetings WHERE meeting_id = ?'
  ).bind(meetingId).first();
  return !!row;
}

async function fetchFirefliesTranscript(apiKey: string, meetingId: string) {
  const query = `
    query GetTranscript($meetingId: String!) {
      transcript(id: $meetingId) {
        id
        title
        date
        duration
        participants
        sentences {
          index
          speaker_name
          text
          start_time
          end_time
        }
      }
    }
  `;

  const res = await fetch('https://api.fireflies.ai/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, variables: { meetingId } }),
  });

  if (!res.ok) throw new Error(`Fireflies API error: ${res.status}`);
  const data = await res.json() as any;
  if (data.errors) throw new Error(`GraphQL error: ${JSON.stringify(data.errors)}`);
  return data.data.transcript;
}

async function fetchRecentFirefliesMeetings(apiKey: string) {
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;

  const query = `
    query {
      transcripts(limit: 20) {
        id
        title
        date
        participants
      }
    }
  `;

  const res = await fetch('https://api.fireflies.ai/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) throw new Error(`Fireflies poll error: ${res.status}`);
  const data = await res.json() as any;
  if (data.errors) throw new Error(`GraphQL error: ${JSON.stringify(data.errors)}`);

  return (data.data.transcripts as any[]).filter(t => t.date >= twoHoursAgo);
}

// ─── Webhook + Cron handler ──────────────────────────────────────────────────

export default {
  // Webhook from Fireflies
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const secret = req.headers.get('x-webhook-secret');
    if (secret !== env.FIREFLIES_WEBHOOK_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }

    let body: any;
    try {
      body = await req.json();
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }

    // Handle new Fireflies webhook format
    if (body.event !== 'meeting.transcribed') {
      return new Response('Not a transcription event, skipping', { status: 200 });
    }

    const meetingId = body.meeting_id;
    if (!meetingId) {
      return new Response('No meeting_id in payload', { status: 400 });
    }

    // Check D1 dedup first
    const alreadyDone = await isAlreadyProcessed(env.DB, meetingId);
    if (alreadyDone) {
      return new Response('Already processed', { status: 200 });
    }

    // Fetch transcript from Fireflies to get participants
    let transcript: any;
    try {
      transcript = await fetchFirefliesTranscript(env.FIREFLIES_API_KEY, meetingId);
    } catch (e: any) {
      console.error('Failed to fetch transcript:', e.message);
      return new Response('Failed to fetch transcript', { status: 500 });
    }

    if (!transcript) {
      return new Response('Transcript not found', { status: 404 });
    }

    // Parse participants from flat string Fireflies returns
    const participantEmails = (transcript.participants as string[])
      .flatMap((p: string) => p.split(','))
      .map((e: string) => e.trim().toLowerCase())
      .filter((e: string) => e.includes('@') && !e.includes('fireflies'));

    // Check if a closer is in this call
    const hasCloser = participantEmails.some(e => CLOSER_EMAILS.includes(e));
    if (!hasCloser) {
      return new Response('Not a closer call, skipping', { status: 200 });
    }

    // Build participants array for workflow
    const participants = participantEmails.map(email => ({
      email,
      name: email.split('@')[0],
    }));

    // Trigger workflow
    try {
      await env.CALL_REVIEW_WORKFLOW.create({
        id: `call-${meetingId}`,
        params: {
          meetingId,
          title: transcript.title,
          participants,
        },
      });
    } catch (e: any) {
      if (e.message?.includes('already exists')) {
        return new Response('Already processed', { status: 200 });
      }
      throw e;
    }

    console.log('Workflow started for:', transcript.title);
    return new Response('Workflow started', { status: 200 });
  },

  // Cron fallback — runs every hour
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    console.log('Cron running — checking for missed meetings');

    const recentMeetings = await fetchRecentFirefliesMeetings(env.FIREFLIES_API_KEY);
    console.log(`Found ${recentMeetings.length} recent meetings`);

    for (const meeting of recentMeetings) {
      const alreadyDone = await isAlreadyProcessed(env.DB, meeting.id);
      if (alreadyDone) {
        console.log(`Already processed: ${meeting.id}`);
        continue;
      }

      // Parse participants from the flat string Fireflies returns
      const participantEmails = (meeting.participants as string[])
        .flatMap((p: string) => p.split(','))
        .map((e: string) => e.trim().toLowerCase())
        .filter((e: string) => e.includes('@'));

      const hasCloser = participantEmails.some(e => CLOSER_EMAILS.includes(e));
      if (!hasCloser) {
        console.log(`No closer in meeting: ${meeting.id}`);
        continue;
      }

      // Build participants array for workflow
      const participants = participantEmails
        .filter(e => !e.includes('fireflies'))
        .map(email => ({
          email,
          name: email.split('@')[0],
        }));

      console.log(`Triggering missed meeting: ${meeting.id} — ${meeting.title}`);

      try {
        await env.CALL_REVIEW_WORKFLOW.create({
          id: `call-${meeting.id}`,
          params: {
            meetingId: meeting.id,
            title: meeting.title,
            participants,
          },
        });
      } catch (e: any) {
        if (!e.message?.includes('already exists')) {
          console.error(`Failed to create workflow for ${meeting.id}:`, e.message);
        }
      }
    }

    console.log('Cron done');
  },
};

// ─── Workflow ────────────────────────────────────────────────────────────────

export class CallReviewWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {

    // Step 1: Fetch transcript
    const transcript = await step.do('fetch transcript', {
      retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
      timeout: '2 minutes',
    }, async () => {
      return await fetchFirefliesTranscript(
        this.env.FIREFLIES_API_KEY,
        event.payload.meetingId
      );
    });

    // Guard: skip no-show meetings
    if (!transcript.sentences || transcript.sentences.length < 10) {
      console.log(`Skipping — only ${transcript.sentences?.length ?? 0} sentences. Likely a no-show.`);
      await this.env.DB.prepare(
        'INSERT OR IGNORE INTO processed_meetings (meeting_id, closer_email, closer_name, lead_name, score, processed_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(event.payload.meetingId, null, null, null, null, Date.now()).run();
      return;
    }

    // Step 2: Generate AI review
    const transcriptText = transcript.sentences
      .map((s: any) => `${s.speaker_name}: ${s.text}`)
      .join('\n');

    const review = await step.do('generate review', {
      retries: { limit: 2, delay: '15 seconds', backoff: 'exponential' },
      timeout: '5 minutes',
    }, async () => {
      const playbook = await this.env.PLAYBOOK_KV.get('metana-playbook') ?? '';

      const response = await this.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        max_tokens: 4000,
        messages: [
          {
            role: 'user',
            content: `Here is the Metana sales playbook and closer handbook. Use this as context when reviewing the call:\n\n${playbook}`,
          },
          {
            role: 'assistant',
            content: 'Understood. I have read the Metana sales playbook and will use it as context for my review.',
          },
          {
            role: 'system',
            content: `You are "Apex," the world's most effective and insightful sales coach. Your expertise combines tactical execution, strategic conversational intelligence, and the psychology of peak performance.

Your purpose is to analyze sales calls with rigorous detail, provide a comprehensive score, and deliver actionable, inspiring coaching to elevate skills to an elite level. You are not just a script-checker; you are a master of human connection and a builder of self-confidence.

## CORE PHILOSOPHY

Your analysis is based on a multi-layered methodology:

**1. The Apex Mindset & Frame Control:**
* Expert Consultant, Not Salesperson: You are the authority, you ask the questions, and you prescribe the solution if there is a fit.
* Qualify Hard, Close Easy: The goal is to determine if the prospect is a good fit, not to sell to everyone. Be willing to disqualify.
* Assume the Close: Operate with the confidence that a good-fit prospect will move forward. The question is "how," not "if."
* Set the Agenda: Start the call by clearly outlining the structure to establish control.

**2. The Skill of Self-Confidence:**
* Positive Reinforcement: Your primary coaching tool is to "catch me being good." You will always start by highlighting successes.
* Constructive Framing: All feedback will be framed as "Opportunities for Growth," never as failures.

**3. The Strategic Framework (The Three Conversations):**
* Practical: The "what's this all about?" conversation (solutions, data, logic).
* Emotional: The "how do we feel?" conversation (empathy, validation, being heard).
* Social: The "who are we?" conversation (identities, status, relationships).
Your analysis will hinge on the Matching Principle: did the salesperson correctly identify and match the prospect's conversational needs?

**4. The Tactical Toolkit (The Apex Sales Framework):**
You are an expert in these tactical elements critical for high-ticket closing:
* High-Authority Agenda Framing
* The Pain Funnel & Challenging Vague Language
* Tailored Value Proposition & The "Brutal Honesty" Pivot
* Proactive Objection Surfacing
* Closing Mechanics & Securing Commitment
* "Two Futures" Frame
* "Home Gym vs. Gym Membership" Analogy
* Pre-Close Temperature Check (1–10 Scale)
* "Commitment Slice" Close
* A/B/C Motivation Funnel
* Skepticism Acknowledgment & Reframe
* "Seeker vs. Waiter" Identity Frame
* "Magic Wand" & "[Name] 2.0" Vision Building
* The Pre-Close Tie-Down
* The "80/20 Confidence" Reframe
* The "King's Crown" Analogy
* The "Cappuccino Close"

Always respond using exactly the format requested. No extra commentary outside the format.`,
          },
          {
            role: 'user',
            content: `Analyze this sales call transcript and provide a full Apex coaching review.

Call Title: ${transcript.title}
Duration: ${transcript.duration} minutes
Date: ${new Date(transcript.date).toLocaleDateString()}

Transcript:
${transcriptText}

Provide your review in this EXACT seven-step format:

## Apex Analysis: ${transcript.title} - [Salesperson's Name]

**Step 1: Executive Summary & Prediction**
* **Prediction:** **[High/Medium-High/Medium/Medium-Low/Low] - [XX%]**
  * **Justification:** [1-2 sentence explanation.]
* **Key Call Moments:**
  * **Strongest Buying Signal:** [MM:SS] - "[Quote]"
  * **Most Critical Objection:** [MM:SS] - "[Quote]"
  * **Final Commitment/Next Steps:** [MM:SS] - "[Quote or 'None - Vague close']"
* **Overall Summary & Apex Score:** [Brief summary. Final score: XX/100]

**Step 2: Sales Dynamic Analysis (The Prospect Profile)**
* **Prospect Quality Score:** [Score/10]
* **Profile:** [Archetype description]
* **Main Issue:** [Core problem with the lead]
* **Call Outcome Attribution:** [Was outcome due to prospect quality or salesperson performance? Could perfect Apex execution have changed the outcome?]

**Step 3: The Apex Scorecard (Salesperson Performance)**

**A. Mindset & Frame Control (20 Points)**
* Confidence & Authority ( /10): [Justification]
  * **Path to a Perfect Score:** [Actionable advice]. **Potential Score: [X/10]**
* Empathy & Rapport ( /10): [Justification]
  * **Path to a Perfect Score:** [Actionable advice]. **Potential Score: [X/10]**

**B. Strategic Diagnosis (30 Points)**
* Identified Conversational Bucket ( /15): [Justification]
  * **Path to a Perfect Score:** [Actionable advice]. **Potential Score: [X/15]**
* Use of Deep Questions ( /15): [Justification]
  * **Path to a Perfect Score:** [Actionable advice]. **Potential Score: [X/15]**

**C. Tactical Execution (15 Points)**
* Agenda Framing & Pain Discovery ( /10): [Justification]
  * **Path to a Perfect Score:** [Actionable advice]. **Potential Score: [X/10]**
* Vision Building & Bridge ( /5): [Justification]
  * **Path to a Perfect Score:** [Actionable advice]. **Potential Score: [X/5]**

**D. Cost of Inaction (5 Points)**
* Quantification & Urgency ( /5): [Justification]
  * **Path to a Perfect Score:** [Actionable advice]. **Potential Score: [X/5]**

**E. Closing & Commitment (30 Points)**
* Asking for the Sale & Objection Handling ( /15): [Justification]
  * **Path to a Perfect Score:** [Actionable advice]. **Potential Score: [X/15]**
* Securing Commitment ( /15): [Justification]
  * **Path to a Perfect Score:** [Actionable advice]. **Potential Score: [X/15]**

**APEX SCORE: [TOTAL]/100**

**Step 4: Novel Technique Identification**
[Any unique techniques not in the Tactical Toolkit, or "No new techniques identified."]

**Step 5: Cost of Inaction (COI) Analysis**
1. **Evidence Extraction:**
   * **Quantification Quote:** [Quote or "None found"]
   * **Future Pacing Quote:** [Quote or "None found"]
2. **COI Score (1-5):** [Score]
3. **Actionable Feedback:** [Single sentence]

**Step 6: Detailed Breakdown & Coaching**

**1. Catching You Being Good (Key Wins 🏆)**
[2-3 moments of exceptional performance with timestamps [MM:SS] and quotes]

**2. Opportunities for Growth (Refinement Areas 📈)**
[2-3 missed opportunities with timestamps [MM:SS], better approach, and word-for-word example of what to say]

**3. Deep Question Development (Your Next Level 🧠)**
[3 deep questions that could have been asked, with timestamps [MM:SS] indicating when]

**Step 7: Actionable Next Steps**
[1-2 most important things to focus on before the next sales call]`,
          },
        ],
      }) as any;

      return response.response;
    });

    // Extract score from review text (Apex score is out of 100)
    const scoreMatch = review.match(/APEX SCORE:\s*(\d+)\s*\/\s*100/i);
    const score = scoreMatch ? parseInt(scoreMatch[1]) : null;

    // Step 3: Find HubSpot contact
    const hubspotContact = await step.do('find hubspot contact', {
      retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
      timeout: '1 minute',
    }, async () => {
      const prospectEmail = event.payload.participants
        .find(p => !CLOSER_EMAILS.includes(p.email.toLowerCase()))?.email;

      if (!prospectEmail) throw new Error('No prospect email found');

      console.log('Looking up HubSpot contact for:', prospectEmail);

      const res = await fetch(
        `https://api.hubapi.com/contacts/v1/contact/email/${encodeURIComponent(prospectEmail)}/profile`,
        {
          headers: {
            'Authorization': `Bearer ${this.env.HUBSPOT_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (res.status === 404) throw new Error(`No HubSpot contact found for ${prospectEmail}`);
      if (!res.ok) throw new Error(`HubSpot API error: ${res.status}`);

      const data = await res.json() as any;
      const firstName = data.properties?.firstname?.value ?? '';
      const lastName = data.properties?.lastname?.value ?? '';
      const fullName = `${firstName} ${lastName}`.trim() || prospectEmail;

      console.log('Found contact:', fullName, 'ID:', data.vid);
      return { id: data.vid.toString(), fullName };
    });

    // Step 4: Post HubSpot note
    await step.do('post hubspot note', {
      retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
      timeout: '1 minute',
    }, async () => {
      const noteBody = `📞 CALL REVIEW — ${transcript.title}
Date: ${new Date(transcript.date).toLocaleDateString()}
Duration: ${transcript.duration} mins

${review}`;

      const res = await fetch('https://api.hubapi.com/engagements/v1/engagements', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.env.HUBSPOT_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          engagement: { active: true, type: 'NOTE', timestamp: transcript.date },
          associations: { contactIds: [parseInt(hubspotContact.id)] },
          metadata: { body: noteBody },
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`HubSpot note error: ${res.status} — ${err}`);
      }

      const data = await res.json() as any;
      console.log('Note posted, engagement ID:', data.engagement.id);
      return data.engagement.id;
    });

    // Step 5: Save to D1
    await step.do('save to database', async () => {
      const closer = event.payload.participants
        .find(p => CLOSER_EMAILS.includes(p.email.toLowerCase()));

      await this.env.DB.prepare(
        `INSERT OR IGNORE INTO processed_meetings
         (meeting_id, closer_email, closer_name, lead_name, score, processed_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(
        event.payload.meetingId,
        closer?.email ?? null,
        closer?.name ?? null,
        hubspotContact.fullName,
        score,
        Date.now()
      ).run();

      console.log(`Saved to D1 — score: ${score}`);
    });

    // Step 6: Slack notification
    if (this.env.SLACK_DISABLED !== 'true') {
      await step.do('send slack notification', {
        retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
        timeout: '30 seconds',
      }, async () => {
        const closerName = event.payload.participants
          .find(p => CLOSER_EMAILS.includes(p.email.toLowerCase()))?.name ?? 'Unknown';

        const hubspotLink = `https://app.hubspot.com/contacts/20654174/contact/${hubspotContact.id}`;

        const res = await fetch(this.env.SLACK_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: `📞 Call review complete — ${closerName} × ${hubspotContact.fullName}${score !== null ? ` (${score}/100)` : ''}`,
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `*${closerName}* × *${hubspotContact.fullName}*`,
                },
              },
              {
                type: 'header',
                text: { type: 'plain_text', text: 'Call review complete 🚀' },
              },
              {
                type: 'section',
                fields: [
                  { type: 'mrkdwn', text: `*Closer*\n${closerName}` },
                  { type: 'mrkdwn', text: `*Lead*\n${hubspotContact.fullName}` },
                ],
              },
              {
                type: 'actions',
                elements: [
                  {
                    type: 'button',
                    text: { type: 'plain_text', text: 'View in HubSpot' },
                    url: hubspotLink,
                  },
                ],
              },
            ],
          }),
        });

        if (!res.ok) throw new Error(`Slack error: ${res.status}`);
      });
    }

    console.log('✅ Done —', hubspotContact.fullName, '— score:', score);
  }
}
