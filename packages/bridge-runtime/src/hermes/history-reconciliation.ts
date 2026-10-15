import { createHash } from 'node:crypto';
import { normalizeHermesHistoryContent, type HermesHistoryMessage } from './native-sessions.js';
import { isRecord } from './internal.js';

type CursorHistoryMessage = HermesHistoryMessage & { _cursorId: string; _sortId: string };

export function mergeHermesHistoryMessages(
  nativeMessages: HermesHistoryMessage[],
  localMessages: HermesHistoryMessage[],
  persistedAliases: Record<string, { toolCallId: string; toolName?: string }> = {},
): CursorHistoryMessage[] {
  // SSE tools have Bridge IDs; native history learns provider IDs later.
  // Keep the live identity authoritative while this runtime still owns it.
  const toolAliases = new Map<string, { toolCallId?: string; toolName?: string; isError?: boolean }>(Object.entries(persistedAliases));
  for (const [id, message] of localMessages.flatMap(message => (
    message.role === 'toolResult' && message._nativeToolCallId && message.toolCallId
      ? [[message._nativeToolCallId, message] as const] : []
  ))) toolAliases.set(id, message);
  nativeMessages = nativeMessages.map(message => {
    if (message.role === 'toolResult' && message.toolCallId) {
      const local = toolAliases.get(message.toolCallId);
      if (local) return { ...message, toolCallId: local.toolCallId, toolName: local.toolName ?? message.toolName, isError: local.isError === true || message.isError === true };
    }
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      return { ...message, content: message.content.map(block => {
        if (!isRecord(block) || block.type !== 'toolCall' || typeof block.id !== 'string') return block;
        const local = toolAliases.get(block.id);
        return local ? { ...block, id: local.toolCallId } : block;
      }) };
    }
    return message;
  });
  const nativeByDigest = new Map<string, Array<{
    message: CursorHistoryMessage;
    matched: boolean;
  }>>();
  const taggedNative = nativeMessages.map((message, index) => {
    const digest = hermesHistorySemanticDigest(message);
    const tagged: CursorHistoryMessage = {
      ...message,
      _cursorId: message._cursorId
        ?? `native:${String(message._nativeId ?? index).padStart(20, '0')}`,
      _sortId: `0:${String(Number(message._nativeId) || index).padStart(20, '0')}`,
    };
    const entries = nativeByDigest.get(digest) ?? [];
    entries.push({ message: tagged, matched: false });
    nativeByDigest.set(digest, entries);
    return tagged;
  });

  const localEntries = localMessages.map((message, index) => ({
    digest: hermesHistorySemanticDigest(message),
    index,
    message,
  }));
  const candidatePairs = localEntries.flatMap((local) => {
    const boundaryId = Number(local.message._nativeBoundaryId);
    return (nativeByDigest.get(local.digest) ?? []).flatMap((candidate) => {
      const timestampDelta = Math.abs(candidate.message.timestamp - local.message.timestamp);
      const isEligible = Number.isFinite(boundaryId) && boundaryId >= 0
        ? Number(candidate.message._nativeId) > boundaryId
        : timestampDelta <= 10_000;
      return isEligible ? [{ candidate, local, timestampDelta }] : [];
    });
  }).sort((left, right) => (
    left.timestampDelta - right.timestampDelta
      || left.local.index - right.local.index
      || left.candidate.message._sortId.localeCompare(right.candidate.message._sortId)
  ));
  const matchedLocalIndexes = new Set<number>();
  const localMatches = new Map<number, (typeof candidatePairs)[number]['candidate']>();
  for (const pair of candidatePairs) {
    if (pair.candidate.matched || matchedLocalIndexes.has(pair.local.index)) continue;
    pair.candidate.matched = true;
    matchedLocalIndexes.add(pair.local.index);
    localMatches.set(pair.local.index, pair.candidate);
  }

  const localNativeAnchors = new Map<number, number>();
  const localCounts = new Map<string, number>();
  const mergedLocal = localEntries.map(({ digest, index, message }) => {
    const match = localMatches.get(index);
    const matchedNativeId = Number(match?.message._nativeId);
    const boundaryNativeId = Number(message._nativeBoundaryId);
    const nativeAnchor = Number.isFinite(matchedNativeId)
      ? matchedNativeId
      : (Number.isFinite(boundaryNativeId) ? boundaryNativeId : null);
    if (nativeAnchor != null) {
      localNativeAnchors.set(
        message.timestamp,
        Math.max(localNativeAnchors.get(message.timestamp) ?? -1, nativeAnchor),
      );
    }
    const localOccurrence = (localCounts.get(digest) ?? 0) + 1;
    localCounts.set(digest, localOccurrence);
    return {
      ...(match?.message ?? {}),
      ...message,
      _cursorId: `local:${digest}:${String(localOccurrence).padStart(8, '0')}`,
      _sortId: `1:${String(index).padStart(20, '0')}`,
    };
  });

  const unmatchedNative = taggedNative
    .filter((message) => (
      !(nativeByDigest.get(hermesHistorySemanticDigest(message)) ?? [])
        .some((candidate) => candidate.message === message && candidate.matched)
    ))
    .map((message) => {
      const nativeId = Number(message._nativeId);
      const localAnchor = localNativeAnchors.get(message.timestamp);
      const followsLocalMessages = localAnchor !== undefined
        && Number.isFinite(nativeId)
        && nativeId > localAnchor;
      return {
        ...message,
        _sortId: `${followsLocalMessages ? '2' : '0'}:${String(nativeId || 0).padStart(20, '0')}`,
      };
    });

  return [
    ...unmatchedNative,
    ...mergedLocal,
  ].sort((left, right) => (
    left.timestamp - right.timestamp || left._sortId.localeCompare(right._sortId)
  ));
}

function hermesHistorySemanticDigest(message: HermesHistoryMessage): string {
  // Native Hermes persists one marker per image, while Bridge keeps clean text.
  // Project only locally known image sends; never strip markers from user prose.
  const imageCount = message.role === 'user' && Number.isInteger(message._imageCount)
    && message._imageCount! > 0 && message._imageCount! <= 6 ? message._imageCount! : 0;
  const content = imageCount && typeof message.content === 'string'
    ? `${message.content}${'\n[screenshot]'.repeat(imageCount)}` : message.content;
  return createHash('sha256').update(JSON.stringify({
    role: message.role,
    content: normalizeHermesHistoryContent(content),
    toolName: message.toolName ?? '',
    toolCallId: message.toolCallId ?? '',
    isError: message.isError === true,
  })).digest('base64url');
}

