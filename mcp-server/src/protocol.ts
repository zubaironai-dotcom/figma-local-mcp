/** Selects which connected Figma file a call runs in. Every given field must match. */
export interface Target {
  fileName?: string;
  fileKey?: string;
  connectionId?: string;
}

/** Where a call actually ran; attached to every result and every plugin error. */
export interface RoutedTo {
  connectionId: string;
  fileName: string;
  fileKey: string | null;
  editorType: string;
  currentPage: { id: string; name: string };
}

export interface ChangeSummary {
  created: string[];
  deleted: string[];
  modified: Array<{ id: string; properties: string[] }>;
}

/** Successful result of a plugin call as seen by the MCP layer. */
export interface CallEnvelope {
  callId: string;
  routedTo: RoutedTo;
  queue: { position: number; waitedMs: number };
  result: unknown;
  changes?: ChangeSummary;
  /** Set when change tracking was incomplete (e.g. Figma delivered no change events in time). */
  changesNote?: string;
  rolledBack?: boolean;
  /** Changes of earlier calls in this file that Figma delivered after those calls replied. */
  lateChanges?: Array<{ callId: string; changes: unknown; complete: boolean }>;
  /** Changes Figma reported while several calls were unconfirmed: any of `possibleCallIds` may have made them. */
  unattributedChanges?: Array<{ possibleCallIds: string[]; changes: unknown }>;
  /** E.g. the plugin in that file runs a different build than the server. */
  warnings?: string[];
}

/**
 * Error with structured details (code, routedTo, callId, logs, changes, ...).
 * Details survive the hub -> peer hop because they are sent as plain JSON.
 */
export class BridgeError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'BridgeError';
    this.details = details;
  }

  toJSON(): Record<string, unknown> {
    return { message: this.message, ...this.details };
  }

  static from(value: unknown): BridgeError {
    if (value instanceof BridgeError) return value;
    if (value && typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string') {
      const { message, ...rest } = value as Record<string, unknown>;
      return new BridgeError(message as string, rest);
    }
    return new BridgeError(value instanceof Error ? value.message : String(value));
  }
}
