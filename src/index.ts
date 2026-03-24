import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';

const CLOSER_EMAILS = [
  'giorgio@metana.io',
  'nicoleta@metana.io',
  'james@metana.io',
];

type Env = {
  CALL_REVIEW_WORKFLOW: Workflow;
  FIREFLIES_WEBHOOK_SECRET: string;
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

    await env.CALL_REVIEW_WORKFLOW.create({
      id: `call-${body.meetingId}`,
      params: body,
    });

    return new Response('Workflow started', { status: 200 });
  },
};

export class CallReviewWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
    console.log('Workflow started for:', event.payload.title);
  }
}
