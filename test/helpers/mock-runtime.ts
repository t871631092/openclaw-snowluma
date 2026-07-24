/**
 * Hand-written `PluginRuntime` double for dispatch.ts tests, modelled on
 * `refs/onebot-xucheng/test/helpers/mock-runtime.ts`. Adapted to the exact
 * `pluginRuntime.channel.*` surface `dispatch.ts` calls: `activity.record`,
 * `routing.resolveAgentRoute`, `reply.*`, and `commands.resolveCommandAuthorizedFromAuthorizers`.
 *
 * Deliberately untyped against the real (huge) `PluginRuntime` interface —
 * callers cast the result at the `dispatchBatch(..., { runtime: ... })` call
 * site, same as the reference plugin's tests do. This file exists purely to
 * observe what dispatch.ts passed in (`state.last*Args`) and to script what
 * `dispatchReplyWithBufferedBlockDispatcher` "replies" with.
 */

export interface MockRuntimeState {
  recordedActivity: any[];
  lastRouteArgs: any | null;
  lastEnvelopeArgs: any | null;
  lastFinalizeArgs: any | null;
  lastDispatchArgs: any | null;
  /** One deliver() call, with the given payload. */
  nextDeliverPayload?: { text?: string; mediaUrl?: string; mediaUrls?: string[] };
  /** Multiple sequential deliver() calls (last one tagged kind: "final"). */
  nextDeliverPayloads?: Array<{ text?: string; mediaUrl?: string; mediaUrls?: string[] }>;
  /** When set, dispatchReplyWithBufferedBlockDispatcher invokes onError instead of deliver. */
  nextError?: unknown;
  /** When set, resolveAgentRoute returns this instead of the default stub route. */
  routeOverride?: { sessionKey?: string; accountId?: string; agentId?: string };
  /** When set, resolveCommandAuthorizedFromAuthorizers returns this instead of computing it. */
  commandAuthorizedOverride?: boolean;
}

export function createMockRuntime(state?: Partial<MockRuntimeState>) {
  const s: MockRuntimeState = {
    recordedActivity: [],
    lastRouteArgs: null,
    lastEnvelopeArgs: null,
    lastFinalizeArgs: null,
    lastDispatchArgs: null,
    nextDeliverPayload: { text: "mock-reply" },
    ...state,
  };

  const runtime = {
    channel: {
      activity: {
        record: (x: any) => s.recordedActivity.push(x),
      },
      routing: {
        resolveAgentRoute: (args: any) => {
          s.lastRouteArgs = args;
          return {
            sessionKey: s.routeOverride?.sessionKey ?? "session:test",
            accountId: s.routeOverride?.accountId ?? args.accountId ?? "default",
            agentId: s.routeOverride?.agentId ?? "agent:test",
          };
        },
      },
      reply: {
        resolveEnvelopeFormatOptions: (_cfg: any) => ({ mode: "raw" }),
        formatInboundEnvelope: (args: any) => {
          s.lastEnvelopeArgs = args;
          // Just return the body — tests assert on lastEnvelopeArgs for the
          // structured inputs, not on this string's exact formatting.
          return args.body;
        },
        finalizeInboundContext: (args: any) => {
          s.lastFinalizeArgs = args;
          return { ...args, CommandAuthorized: args.CommandAuthorized ?? false };
        },
        resolveEffectiveMessagesConfig: (_cfg: any, _agentId: string) => ({ responsePrefix: "" }),
        dispatchReplyWithBufferedBlockDispatcher: async ({ ctx, dispatcherOptions }: any) => {
          s.lastDispatchArgs = { ctx, dispatcherOptions };

          if (s.nextError !== undefined) {
            await dispatcherOptions.onError?.(s.nextError, { kind: "final" });
            return { status: "error" };
          }

          const payloads = s.nextDeliverPayloads?.length
            ? s.nextDeliverPayloads
            : [s.nextDeliverPayload ?? { text: "" }];
          for (let i = 0; i < payloads.length; i++) {
            const kind = i === payloads.length - 1 ? "final" : "block";
            await dispatcherOptions.deliver(payloads[i], { kind });
          }
          return { status: "ok" };
        },
      },
      commands: {
        resolveCommandAuthorizedFromAuthorizers: ({ useAccessGroups, authorizers, modeWhenAccessGroupsOff }: any) => {
          if (s.commandAuthorizedOverride !== undefined) return s.commandAuthorizedOverride;
          if (!useAccessGroups) {
            if (modeWhenAccessGroupsOff === "allow") return true;
            if (modeWhenAccessGroupsOff === "deny") return false;
            if (!authorizers.some((entry: any) => entry.configured)) return true;
            return authorizers.some((entry: any) => entry.configured && entry.allowed);
          }
          return authorizers.some((entry: any) => entry.configured && entry.allowed);
        },
      },
    },
  };

  return { runtime, state: s };
}
