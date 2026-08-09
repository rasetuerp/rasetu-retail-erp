import type { PrismaClient as CompanyPrismaClient } from '../generated/company-client/index.js';

// RULES.md #7: every mutation writes AuditLog + SyncQueue entries — one helper
// wraps both so no route ever writes one and forgets the other. Call this
// immediately after the Prisma write that changes `tableName`/`rowId`.
//
// Round 4 — AuditLog/SyncQueue now live inside each company's own database
// (preserves the atomic $transaction below, which can't span two SQLite
// files), so this takes the caller's already-resolved company client instead
// of importing one global instance.

type RecordMutationInput = {
  userId?: string | null;
  entity: string; // "Invoice", "Item", "Party", ... — matches the Prisma model name
  entityId: string;
  action: 'CREATE' | 'UPDATE' | 'CANCEL' | 'DELETE';
  oldValue?: unknown;
  newValue?: unknown;
  tableName: string; // lowerCamel Prisma model name, used as SyncQueue.tableName
  syncAction: 'CREATE' | 'UPDATE' | 'DELETE';
  payload: unknown; // full row snapshot to push to Supabase
};

export async function recordMutation(prisma: CompanyPrismaClient, input: RecordMutationInput) {
  await prisma.$transaction([
    prisma.auditLog.create({
      data: {
        userId: input.userId ?? null,
        entity: input.entity,
        entityId: input.entityId,
        action: input.action,
        oldValue: input.oldValue !== undefined ? JSON.stringify(input.oldValue) : null,
        newValue: input.newValue !== undefined ? JSON.stringify(input.newValue) : null,
      },
    }),
    prisma.syncQueue.create({
      data: {
        tableName: input.tableName,
        rowId: input.entityId,
        action: input.syncAction,
        payload: JSON.stringify(input.payload),
      },
    }),
  ]);
}
