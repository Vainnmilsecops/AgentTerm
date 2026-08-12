import type {
  AgentAdapter,
  AgentAvailability,
  AgentLaunchRequest,
  PtyHandle,
  PtyRuntime,
  PtyRuntimeEventSink,
  PtyTerminalSize,
} from './ports';

export interface LaunchAgentInput extends AgentLaunchRequest {
  readonly eventSink: PtyRuntimeEventSink;
  readonly initialSize: PtyTerminalSize;
}

export function inspectAgent(adapter: AgentAdapter): Promise<AgentAvailability> {
  return adapter.inspect();
}

export async function launchAgent(
  input: LaunchAgentInput,
  adapter: AgentAdapter,
  runtime: PtyRuntime,
): Promise<PtyHandle> {
  const command = await adapter.buildLaunchCommand({
    environment: input.environment,
    workingDirectory: input.workingDirectory,
  });

  return runtime.open(
    {
      arguments: command.arguments,
      environment: command.environment,
      executablePath: command.executablePath,
      initialSize: input.initialSize,
      workingDirectory: command.workingDirectory,
    },
    input.eventSink,
  );
}
