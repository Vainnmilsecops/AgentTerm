import type {
  AgentAdapter,
  AgentAvailability,
  AgentCapability,
  AgentCatalog,
  AgentIdentity,
  AgentLaunchCommand,
  AgentLaunchRequest,
} from './ports';

const MAX_AGENT_ID_LENGTH = 64;
const STABLE_AGENT_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;

export type AgentSummary =
  | {
      readonly capabilities: readonly AgentCapability[];
      readonly displayName: string;
      readonly id: string;
      readonly kind: 'available';
    }
  | {
      readonly displayName: string;
      readonly id: string;
      readonly kind: 'unavailable';
      readonly reason: Extract<AgentAvailability, { kind: 'unavailable' }>['reason'];
    };

export class ConfiguredAgentCatalog implements AgentCatalog {
  private readonly adapters: readonly AgentAdapter[];
  private readonly adaptersById: ReadonlyMap<string, AgentAdapter>;

  public constructor(adapters: readonly AgentAdapter[]) {
    const configured: AgentAdapter[] = [];
    const byId = new Map<string, AgentAdapter>();

    for (const adapter of adapters) {
      const identity = snapshotAgentIdentity(adapter.identity);
      const registered = Object.freeze(new RegisteredAgentAdapter(adapter, identity));
      const { id } = identity;
      if (byId.has(id)) {
        throw new TypeError(`Duplicate Agent id: ${id}.`);
      }
      configured.push(registered);
      byId.set(id, registered);
    }

    this.adapters = Object.freeze(configured);
    this.adaptersById = byId;
  }

  public findById(id: string): AgentAdapter | undefined {
    return this.adaptersById.get(id);
  }

  public list(): readonly AgentAdapter[] {
    return this.adapters;
  }
}

class RegisteredAgentAdapter implements AgentAdapter {
  public constructor(
    private readonly adapter: AgentAdapter,
    public readonly identity: AgentIdentity,
  ) {}

  public inspect(): Promise<AgentAvailability> {
    return this.adapter.inspect();
  }

  public buildLaunchCommand(request: AgentLaunchRequest): Promise<AgentLaunchCommand> {
    return this.adapter.buildLaunchCommand(request);
  }
}

export async function listAgentSummaries(catalog: AgentCatalog): Promise<readonly AgentSummary[]> {
  const summaries = await Promise.all(
    catalog.list().map(async (adapter): Promise<AgentSummary> => {
      const availability = await adapter.inspect();
      const identity = adapter.identity;
      if (availability.kind === 'unavailable') {
        return Object.freeze({
          displayName: identity.displayName,
          id: identity.id,
          kind: availability.kind,
          reason: availability.reason,
        });
      }

      return Object.freeze({
        capabilities: Object.freeze([...availability.capabilities]),
        displayName: identity.displayName,
        id: identity.id,
        kind: availability.kind,
      });
    }),
  );
  return Object.freeze(summaries);
}

function snapshotAgentIdentity(source: AgentIdentity): AgentIdentity {
  const identity = Object.freeze({ displayName: source?.displayName, id: source?.id });
  if (
    typeof identity?.id !== 'string' ||
    identity.id.length > MAX_AGENT_ID_LENGTH ||
    !STABLE_AGENT_ID.test(identity.id)
  ) {
    throw new TypeError('Agent id must be a stable identifier.');
  }
  if (typeof identity.displayName !== 'string' || identity.displayName.trim().length === 0) {
    throw new TypeError('Agent display name must not be blank.');
  }
  return identity;
}
