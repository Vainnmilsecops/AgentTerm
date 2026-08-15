import { readFileSync, writeFileSync } from 'node:fs';

import { QualityGateKind, type QualityGate } from '@agentterm/domain';

import type { QualityGateCatalog } from '@agentterm/application';

interface PersistedGate {
  readonly arguments: readonly string[];
  readonly executablePath: string;
  readonly id: string;
  readonly kind: QualityGate['kind'];
  readonly timeoutMs: number;
}

const stableGateIdPattern = /^[a-z0-9]+(?:[._:=-][a-z0-9]+)*$/u;
const absoluteExecutablePathPattern = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/u;

export interface JsonFileQualityGateCatalogOptions {
  readonly filePath: string;
}

export class JsonFileQualityGateCatalog implements QualityGateCatalog {
  private readonly filePath: string;
  private readonly gates = new Map<string, QualityGate>();

  public constructor(options: JsonFileQualityGateCatalogOptions) {
    this.filePath = options.filePath;
    this.load();
  }

  public async findById(id: string): Promise<QualityGate | undefined> {
    return this.gates.get(id);
  }

  public async list(): Promise<readonly QualityGate[]> {
    return Object.freeze([...this.gates.values()]);
  }

  public async register(gate: QualityGate): Promise<void> {
    assertValidGate(gate);
    if (this.gates.has(gate.id)) {
      throw new Error(`Quality Gate ${gate.id} is already configured.`);
    }
    this.gates.set(gate.id, gate);
    this.persist();
  }

  public async unregister(id: string): Promise<boolean> {
    if (!stableGateIdPattern.test(id)) {
      throw new Error('Quality Gate id is invalid.');
    }
    const removed = this.gates.delete(id);
    if (removed) this.persist();
    return removed;
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { gates?: readonly PersistedGate[] };
      if (!Array.isArray(parsed.gates)) return;
      for (const persisted of parsed.gates) {
        const gate = reviveGate(persisted);
        if (gate !== undefined) {
          this.gates.set(gate.id, gate);
        }
      }
    } catch {
      // ignore malformed file; user re-registers
    }
  }

  private persist(): void {
    const payload = JSON.stringify(
      {
        gates: [...this.gates.values()].map((gate) => ({
          arguments: gate.command.arguments,
          executablePath: gate.command.executablePath,
          id: gate.id,
          kind: gate.kind,
          timeoutMs: gate.timeoutMs,
        })),
      },
      null,
      2,
    );
    writeFileSync(this.filePath, `${payload}\n`, 'utf8');
  }
}

function reviveGate(persisted: PersistedGate): QualityGate | undefined {
  if (
    typeof persisted !== 'object' ||
    persisted === null ||
    typeof persisted.id !== 'string' ||
    !stableGateIdPattern.test(persisted.id) ||
    !Object.values(QualityGateKind).includes(persisted.kind) ||
    typeof persisted.executablePath !== 'string' ||
    !absoluteExecutablePathPattern.test(persisted.executablePath) ||
    !Array.isArray(persisted.arguments) ||
    !persisted.arguments.every((argument) => typeof argument === 'string') ||
    !Number.isInteger(persisted.timeoutMs) ||
    persisted.timeoutMs <= 0
  ) {
    return undefined;
  }
  return Object.freeze({
    command: Object.freeze({
      arguments: Object.freeze([...persisted.arguments]),
      executablePath: persisted.executablePath,
    }),
    id: persisted.id,
    kind: persisted.kind,
    timeoutMs: persisted.timeoutMs,
  });
}

function assertValidGate(gate: QualityGate): void {
  if (!stableGateIdPattern.test(gate.id)) {
    throw new Error('Quality Gate id is invalid.');
  }
  if (!Object.values(QualityGateKind).includes(gate.kind)) {
    throw new Error('Quality Gate kind is not supported.');
  }
  if (!absoluteExecutablePathPattern.test(gate.command.executablePath)) {
    throw new Error('Quality Gate executablePath must be absolute.');
  }
  if (!Number.isInteger(gate.timeoutMs) || gate.timeoutMs <= 0) {
    throw new Error('Quality Gate timeoutMs must be a positive integer.');
  }
}
