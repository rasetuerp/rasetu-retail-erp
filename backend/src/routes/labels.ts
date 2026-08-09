import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requireCompanyDb } from '../lib/auth-middleware.js';
import { asyncHandler } from '../lib/async-handler.js';
import { recordMutation } from '../lib/mutation-log.js';
import { HttpError } from '../lib/http-error.js';
import type { PrismaClient as CompanyPrismaClient } from '../generated/company-client/index.js';

// Round 7 — replaces the old 3-name label-settings Setting key (small-tag/
// medium-tag/shelf-label had no actual dimension or layout data behind them —
// printing via that path would runtime-fail). Each LabelTemplate row is a
// full, free-drag label design: arbitrary mm size + a positioned element list
// (rendered/edited in src/components/pages/LabelDesignerPage.tsx), built into
// real TSPL by the already-existing electron/printer-driver.ts engine.

export const labelsRouter = Router({ mergeParams: true });

labelsRouter.use(requireAuth);

labelsRouter.get(
  '/queue-data',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const { itemIds } = req.query as { itemIds?: string };
    const ids = itemIds?.split(',') ?? [];
    const items = await prisma.item.findMany({ where: { id: { in: ids } } });
    res.json({ items });
  })
);

const labelElementSchema = z
  .object({
    id: z.string(),
    type: z.enum(['field', 'text', 'barcode', 'qrcode', 'line', 'rectangle', 'image']),
    xMm: z.number(),
    yMm: z.number(),
    widthMm: z.number(),
    heightMm: z.number(),
    fontSize: z.number().optional(),
    bold: z.boolean().optional(),
    align: z.enum(['left', 'center', 'right']).optional(),
    sourceKey: z.string().optional(), // 'field' | 'barcode' | 'qrcode' elements
    content: z.string().optional(), // 'text' elements
    showLabel: z.boolean().optional(),
    displayLabel: z.string().optional(),
    barcodeType: z.enum(['code128', 'code39', 'ean13', 'upca']).optional(),
  })
  .passthrough();

const printConfigSchema = z
  .object({
    darkness: z.number().min(0).max(15).default(8),
    gapMm: z.number().min(0).default(2),
    xOffsetMm: z.number().default(0),
    yOffsetMm: z.number().default(0),
    dpi: z.union([z.literal(203), z.literal(300)]).default(203),
  })
  // Round 21 — loopZone (and any future printConfig field) round-trips
  // through this the same way labelElementSchema above already does; without
  // passthrough, z.object() silently strips unknown keys on save.
  .passthrough();

const labelTemplateBodySchema = z.object({
  name: z.string().min(1),
  isDefault: z.boolean().default(false),
  widthMm: z.number().positive(),
  heightMm: z.number().positive(),
  elements: z.array(labelElementSchema).default([]),
  printConfig: printConfigSchema.default(printConfigSchema.parse({})),
});

function serializeTemplate(row: {
  id: string;
  name: string;
  isDefault: boolean;
  widthMm: unknown;
  heightMm: unknown;
  elements: string;
  printConfig: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    isDefault: row.isDefault,
    widthMm: Number(row.widthMm),
    heightMm: Number(row.heightMm),
    elements: JSON.parse(row.elements),
    printConfig: JSON.parse(row.printConfig),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

labelsRouter.get(
  '/label-templates',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const rows = await prisma.labelTemplate.findMany({
      where: { companyId: req.params.companyId },
      orderBy: { name: 'asc' },
    });
    res.json({ templates: rows.map(serializeTemplate) });
  })
);

async function clearOtherDefaults(prisma: CompanyPrismaClient, companyId: string, exceptId?: string) {
  await prisma.labelTemplate.updateMany({
    where: { companyId, isDefault: true, ...(exceptId ? { id: { not: exceptId } } : {}) },
    data: { isDefault: false },
  });
}

labelsRouter.post(
  '/label-templates',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const input = labelTemplateBodySchema.parse(req.body);

    const created = await prisma.$transaction(async (tx) => {
      if (input.isDefault) await clearOtherDefaults(tx as CompanyPrismaClient, req.params.companyId);
      return tx.labelTemplate.create({
        data: {
          companyId: req.params.companyId,
          name: input.name,
          isDefault: input.isDefault,
          widthMm: input.widthMm,
          heightMm: input.heightMm,
          elements: JSON.stringify(input.elements),
          printConfig: JSON.stringify(input.printConfig),
        },
      });
    });

    await recordMutation(prisma, {
      userId: req.user?.id,
      entity: 'LabelTemplate',
      entityId: created.id,
      action: 'CREATE',
      newValue: created,
      tableName: 'labelTemplate',
      syncAction: 'CREATE',
      payload: created,
    });

    res.status(201).json({ template: serializeTemplate(created) });
  })
);

labelsRouter.put(
  '/label-templates/:id',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const input = labelTemplateBodySchema.parse(req.body);
    const existing = await prisma.labelTemplate.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.companyId !== req.params.companyId) throw new HttpError(404, 'Label template not found');

    const updated = await prisma.$transaction(async (tx) => {
      if (input.isDefault) await clearOtherDefaults(tx as CompanyPrismaClient, req.params.companyId, existing.id);
      return tx.labelTemplate.update({
        where: { id: existing.id },
        data: {
          name: input.name,
          isDefault: input.isDefault,
          widthMm: input.widthMm,
          heightMm: input.heightMm,
          elements: JSON.stringify(input.elements),
          printConfig: JSON.stringify(input.printConfig),
        },
      });
    });

    await recordMutation(prisma, {
      userId: req.user?.id,
      entity: 'LabelTemplate',
      entityId: updated.id,
      action: 'UPDATE',
      oldValue: existing,
      newValue: updated,
      tableName: 'labelTemplate',
      syncAction: 'UPDATE',
      payload: updated,
    });

    res.json({ template: serializeTemplate(updated) });
  })
);

labelsRouter.delete(
  '/label-templates/:id',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const existing = await prisma.labelTemplate.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.companyId !== req.params.companyId) throw new HttpError(404, 'Label template not found');

    await prisma.labelTemplate.delete({ where: { id: existing.id } });

    await recordMutation(prisma, {
      userId: req.user?.id,
      entity: 'LabelTemplate',
      entityId: existing.id,
      action: 'DELETE',
      oldValue: existing,
      tableName: 'labelTemplate',
      syncAction: 'DELETE',
      payload: { id: existing.id },
    });

    res.status(204).send();
  })
);

labelsRouter.post(
  '/label-templates/:id/duplicate',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const existing = await prisma.labelTemplate.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.companyId !== req.params.companyId) throw new HttpError(404, 'Label template not found');

    // Copy N never collides with an existing name — same "find the next free
    // suffix" approach used elsewhere for SKU-like uniqueness constraints.
    let copyName = `${existing.name} (copy)`;
    let n = 2;
    while (await prisma.labelTemplate.findUnique({ where: { companyId_name: { companyId: req.params.companyId, name: copyName } } })) {
      copyName = `${existing.name} (copy ${n})`;
      n += 1;
    }

    const created = await prisma.labelTemplate.create({
      data: {
        companyId: req.params.companyId,
        name: copyName,
        isDefault: false,
        widthMm: existing.widthMm,
        heightMm: existing.heightMm,
        elements: existing.elements,
        printConfig: existing.printConfig,
      },
    });

    await recordMutation(prisma, {
      userId: req.user?.id,
      entity: 'LabelTemplate',
      entityId: created.id,
      action: 'CREATE',
      newValue: created,
      tableName: 'labelTemplate',
      syncAction: 'CREATE',
      payload: created,
    });

    res.status(201).json({ template: serializeTemplate(created) });
  })
);
