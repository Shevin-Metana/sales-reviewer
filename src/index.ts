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
  AI: Ai;
};

type WorkflowParams = {
  meetingId: string;
  title: string;
  participants: { name: string; email: string }[];
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const secret = req.headers.get('x-webhook-secret');
    if (secret !== env.FIREFLIES_WEBHOOK_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }

    let body: WorkflowParams;
    try {
      body = await req.json();
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }

    const hasCloser = body.participants.some(p =>
      CLOSER_EMAILS.includes(p.email.toLowerCase())
    );

    if (!hasCloser) {
      return new Response('Not a closer call, skipping', { status: 200 });
    }

    try {
      await env.CALL_REVIEW_WORKFLOW.create({
        id: `call-${body.meetingId}-${Date.now()}`,
        params: body,
      });
    } catch (e: any) {
      if (e.message?.includes('already exists')) {
        return new Response('Already processed', { status: 200 });
      }
      throw e;
    }

    return new Response('Workflow started', { status: 200 });
  },
};

export class CallReviewWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {

    // Step 1: Fetch transcript from Fireflies
    const transcript = await step.do('fetch transcript', {
      retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
      timeout: '2 minutes',
    }, async () => {
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
          'Authorization': `Bearer ${this.env.FIREFLIES_API_KEY}`,
        },
        body: JSON.stringify({
          query,
          variables: { meetingId: event.payload.meetingId },
        }),
      });

      if (!res.ok) throw new Error(`Fireflies API error: ${res.status}`);

      const data = await res.json() as any;
      if (data.errors) throw new Error(`GraphQL error: ${JSON.stringify(data.errors)}`);

      return data.data.transcript;
    });

    // Step 2: Generate AI review using Cloudflare Workers AI
    const transcriptText = transcript.sentences
      .map((s: any) => `${s.speaker_name}: ${s.text}`)
      .join('\n');

    const review = await step.do('generate review', {
      retries: { limit: 2, delay: '15 seconds', backoff: 'exponential' },
      timeout: '5 minutes',
    }, async () => {
      const response = await this.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        max_tokens: 1500,
        messages: [
          {
            role: 'system',
            content: `You are a sales call coach reviewing a closer's performance at Metana, a coding bootcamp.
You analyze transcripts and give structured, honest, specific feedback.
Always respond using exactly the format requested. No extra commentary.`,
          },
          {
            role: 'user',
            content: `Analyze this sales call and provide a structured review.

Call Title: ${transcript.title}
Duration: ${transcript.duration} minutes
Date: ${new Date(transcript.date).toLocaleDateString()}

Transcript:
${transcriptText}

Provide your review in this exact format:

OVERALL SCORE: [X/10]

SUMMARY
[2-3 sentence summary of what happened on the call]

WHAT WENT WELL
- [specific moment or behavior]
- [specific moment or behavior]
- [specific moment or behavior]

AREAS TO IMPROVE
- [specific issue with example from transcript]
- [specific issue with example from transcript]

OBJECTION HANDLING
[How well did the closer handle objections? Give specific examples]

CLOSING ATTEMPT
[Did the closer attempt to close? How was it handled?]

NEXT STEPS
[What were the agreed next steps, if any?]

COACHING NOTES
[The single most important thing this closer should work on]`,
          },
        ],
      }) as any;

      return response.response;
    });

    // Step 3: Find HubSpot contact by prospect email
    const hubspotContactId = await step.do('find hubspot contact', {
      retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
      timeout: '1 minute',
    }, async () => {
      const prospectEmail = event.payload.participants
        .find(p => !CLOSER_EMAILS.includes(p.email.toLowerCase()))?.email;

      if (!prospectEmail) throw new Error('No prospect email found in participants');

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
      console.log('Found HubSpot contact ID:', data.vid);
      return data.vid.toString();
    });

    // Step 4: Post review as a note on the HubSpot contact
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
          engagement: {
            active: true,
            type: 'NOTE',
            timestamp: transcript.date,
          },
          associations: {
            contactIds: [parseInt(hubspotContactId)],
          },
          metadata: {
            body: noteBody,
          },
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`HubSpot note error: ${res.status} — ${err}`);
      }

      const data = await res.json() as any;
      console.log('Note posted to HubSpot, engagement ID:', data.engagement.id);
      return data.engagement.id;
    });

    console.log('✅ All done — review posted to HubSpot for:', transcript.title);
  }
}
