import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requireCompanyDb, requireRole } from '../lib/auth-middleware.js';
import { asyncHandler } from '../lib/async-handler.js';
import { recordMutation } from '../lib/mutation-log.js';
import { HttpError } from '../lib/http-error.js';
import { getClothProfile } from '../lib/vertical-profile.js';
import { prisma as catalogPrisma } from '../db/catalog-client.js';
import { abbreviateToCode } from '../lib/code-gen.js';

// Backs SCOPE.md #3 (Item/Stock Master). Attribute set (category/brand/size/
// color/fabric) is the cloth vertical profile — see config/profiles/profile-cloth.json.
// GST-slab-by-MRP auto rule lives in profile.gst.mrpSlabRule; apply it in the
// frontend quick-entry grid (Day 2) rather than duplicating it server-side.

export const itemsRouter = Router({ mergeParams: true });

const createItemSchema = z.object({
  sku: z.string().min(1),
  barcode: z.string().optional(),
  hsn: z.string().optional(),
  category: z.string().optional(),
  brand: z.string().optional(),
  size: z.string().optional(),
  color: z.string().optional(),
  unit: z.string().default('PCS'),
  purchaseRate: z.number().default(0),
  mrp: z.number().default(0),
  sellingRate: z.number().default(0),
  gstRate: z.number().default(0),
  gstInclusive: z.boolean().default(true),
  openingStock: z.number().default(0),
  minStock: z.number().default(0),
  // Round 10 — legal-metrology label fields, all optional (see docs/SCHEMA.md's Round 10 entry).
  commodity: z.string().optional(),
  itemType: z.string().optional(),
  brandCode: z.string().optional(),
  styleCode: z.string().optional(),
  mfgDate: z.coerce.date().optional(),
  netQtyLabel: z.string().optional(),
  // Round 10 — values for shop-added custom item fields (definitions live in
  // the 'item-fields' Setting below, not here); keyed to match those definitions.
  customFields: z.record(z.string()).optional(),
});

itemsRouter.use(requireAuth);

itemsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const { search, lowStock } = req.query as { search?: string; lowStock?: string };
    const items = await prisma.item.findMany({
      where: {
        companyId: req.params.companyId,
        isActive: true,
        ...(search
          ? {
              // Round 5 — widened so a cashier can find a product by whichever
              // detail comes to mind first at the counter.
              OR: [
                { sku: { contains: search } },
                { barcode: { contains: search } },
                { category: { contains: search } },
                { size: { contains: search } },
                { color: { contains: search } },
              ],
            }
          : {}),
      },
      orderBy: { sku: 'asc' },
    });
    const filtered = lowStock === 'true' ? items.filter((i) => i.stockQty.lte(i.minStock)) : items;
    res.json({ items: filtered });
  })
);

itemsRouter.get(
  '/barcode/:barcode',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const item = await prisma.item.findUnique({ where: { barcode: req.params.barcode } });
    res.json({ item });
  })
);

// Round 10 — the vertical profile's itemAttributes (category/brand/size/color
// for cloth) become company-effective here: base profile + this company's
// stored label overrides + this company's own custom fields, merged into one
// list ItemMasterPage.tsx renders exactly like it already does for the raw
// profile. Custom-field values live on Item.customFields; definitions live
// here, in Setting, not the schema — so a shop can add/remove/rename them
// without a migration.
const ITEM_FIELDS_KEY = 'item-fields';
const itemFieldsSettingSchema = z.object({
  labelOverrides: z.record(z.string()).default({}),
  custom: z
    .array(z.object({ key: z.string().min(1), label: z.string().min(1), required: z.boolean().default(false) }))
    .default([]),
});
type ItemFieldsSetting = z.infer<typeof itemFieldsSettingSchema>;

itemsRouter.get(
  '/fields',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const base = getClothProfile();
    const setting = await prisma.setting.findUnique({
      where: { companyId_key: { companyId: req.params.companyId, key: ITEM_FIELDS_KEY } },
    });
    const config: ItemFieldsSetting = setting
      ? itemFieldsSettingSchema.parse(JSON.parse(setting.value))
      : { labelOverrides: {}, custom: [] };

    const itemAttributes = [
      ...base.itemAttributes.map((attr) => ({
        ...attr,
        label: config.labelOverrides[attr.key] ?? attr.label,
        custom: false,
      })),
      ...config.custom.map((c) => ({ key: c.key, label: c.label, type: 'text', required: c.required, custom: true })),
    ];
    res.json({ itemAttributes });
  })
);

itemsRouter.put(
  '/fields',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const input = itemFieldsSettingSchema.parse(req.body);
    const coreKeys = new Set(getClothProfile().itemAttributes.map((a) => a.key));
    for (const c of input.custom) {
      if (coreKeys.has(c.key)) throw new HttpError(400, `"${c.key}" is already a built-in field — choose a different name.`);
    }
    const customKeys = input.custom.map((c) => c.key);
    if (new Set(customKeys).size !== customKeys.length) {
      throw new HttpError(400, 'Custom field names must be unique.');
    }
    const setting = await prisma.setting.upsert({
      where: { companyId_key: { companyId: req.params.companyId, key: ITEM_FIELDS_KEY } },
      create: { companyId: req.params.companyId, key: ITEM_FIELDS_KEY, value: JSON.stringify(input) },
      update: { value: JSON.stringify(input) },
    });
    res.json({ settings: JSON.parse(setting.value) });
  })
);

// Round 11 — auto-generated SKUs: ShopCode-CategoryCode-Year-Serial (e.g.
// "FTS-SHI-26-0001"), serial resets to 1 per (category, year) via SkuCounter.
// Shop code falls back to abbreviateToCode(company.name) when the shop
// hasn't set one in Settings yet — same fallback the Settings screen shows
// as a placeholder, so a freshly-generated SKU matches what Settings will
// later display once the shop opens it. Serials are handed out on request
// (not reserved-until-confirmed): an abandoned form burns that serial, same
// as invoice numbering elsewhere in the app.
const nextSkuSchema = z.object({
  categoryCode: z.string().min(1),
  count: z.number().int().min(1).max(200).default(1),
});

itemsRouter.post(
  '/next-sku',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const input = nextSkuSchema.parse(req.body);
    const company = await catalogPrisma.company.findUniqueOrThrow({ where: { id: req.params.companyId } });
    const shopCode = (company.shopCode || abbreviateToCode(company.name)).toUpperCase();
    const categoryCode = input.categoryCode.toUpperCase();
    const year = new Date().getFullYear() % 100;

    const counter = await prisma.skuCounter.upsert({
      where: { companyId_categoryCode_year: { companyId: req.params.companyId, categoryCode, year } },
      create: { companyId: req.params.companyId, categoryCode, year, lastSerial: input.count },
      update: { lastSerial: { increment: input.count } },
    });

    const startSerial = counter.lastSerial - input.count + 1;
    const yy = String(year).padStart(2, '0');
    const skus = Array.from({ length: input.count }, (_, i) =>
      `${shopCode}-${categoryCode}-${yy}-${String(startSerial + i).padStart(4, '0')}`
    );
    res.json({ skus });
  })
);

itemsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const input = createItemSchema.parse(req.body);

    const item = await prisma.item.create({
      data: {
        companyId: req.params.companyId,
        sku: input.sku,
        barcode: input.barcode,
        hsn: input.hsn,
        category: input.category,
        brand: input.brand,
        size: input.size,
        color: input.color,
        unit: input.unit,
        purchaseRate: input.purchaseRate,
        mrp: input.mrp,
        sellingRate: input.sellingRate,
        gstRate: input.gstRate,
        gstInclusive: input.gstInclusive,
        stockQty: input.openingStock,
        minStock: input.minStock,
        commodity: input.commodity,
        itemType: input.itemType,
        brandCode: input.brandCode,
        styleCode: input.styleCode,
        mfgDate: input.mfgDate,
        netQtyLabel: input.netQtyLabel,
        customFields: input.customFields,
      },
    });

    if (input.openingStock !== 0) {
      await prisma.stockMovement.create({
        data: { itemId: item.id, type: 'OPENING', qty: input.openingStock },
      });
    }

    await recordMutation(prisma, {
      userId: req.user?.id,
      entity: 'Item',
      entityId: item.id,
      action: 'CREATE',
      newValue: item,
      tableName: 'item',
      syncAction: 'CREATE',
      payload: item,
    });

    res.status(201).json({ item });
  })
);

// Round 5 — Bulk Stock Entry: create many items in one atomic call (a batch
// with one bad row, e.g. a duplicate SKU, rolls back entirely rather than
// leaving a half-created batch — worse at 20 rows than at 1). Each row is the
// same shape as a single create; recordMutation runs per item afterward,
// matching the plain (non-transactional) single-item route's own convention.
const bulkCreateItemsSchema = z.object({
  items: z.array(createItemSchema).min(1).max(200),
});

itemsRouter.post(
  '/bulk',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const input = bulkCreateItemsSchema.parse(req.body);

    const created = await prisma.$transaction(async (tx) => {
      const rows = [];
      for (const row of input.items) {
        const item = await tx.item.create({
          data: {
            companyId: req.params.companyId,
            sku: row.sku,
            barcode: row.barcode,
            hsn: row.hsn,
            category: row.category,
            brand: row.brand,
            size: row.size,
            color: row.color,
            unit: row.unit,
            purchaseRate: row.purchaseRate,
            mrp: row.mrp,
            sellingRate: row.sellingRate,
            gstRate: row.gstRate,
            gstInclusive: row.gstInclusive,
            stockQty: row.openingStock,
            minStock: row.minStock,
            commodity: row.commodity,
            itemType: row.itemType,
            brandCode: row.brandCode,
            styleCode: row.styleCode,
            mfgDate: row.mfgDate,
            netQtyLabel: row.netQtyLabel,
            customFields: row.customFields,
          },
        });
        if (row.openingStock !== 0) {
          await tx.stockMovement.create({ data: { itemId: item.id, type: 'OPENING', qty: row.openingStock } });
        }
        rows.push(item);
      }
      return rows;
    });

    for (const item of created) {
      await recordMutation(prisma, {
        userId: req.user?.id,
        entity: 'Item',
        entityId: item.id,
        action: 'CREATE',
        newValue: item,
        tableName: 'item',
        syncAction: 'CREATE',
        payload: item,
      });
    }

    res.status(201).json({ items: created });
  })
);

// Edit endpoint (pre-delivery fixes #1.3/#2.7). Reuses createItemSchema but
// omits openingStock — that field is deliberately remapped to stockQty +
// a StockMovement row at create-time (see POST above) and is not a real
// column on Item, so passing it straight through to prisma.item.update
// would throw "Unknown argument 'openingStock'" (see pre-build review #3).
const updateItemSchema = createItemSchema.omit({ openingStock: true }).partial();

itemsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const input = updateItemSchema.parse(req.body);
    const existing = await prisma.item.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.companyId !== req.params.companyId) throw new HttpError(404, 'Item not found');
    const updated = await prisma.item.update({ where: { id: req.params.id }, data: input });

    await recordMutation(prisma, {
      userId: req.user?.id,
      entity: 'Item',
      entityId: updated.id,
      action: 'UPDATE',
      oldValue: existing,
      newValue: updated,
      tableName: 'item',
      syncAction: 'UPDATE',
      payload: updated,
    });

    res.json({ item: updated });
  })
);

// TODO (Day 2): POST /import for Excel import (xlsx dep already in
// backend/package.json), soft-delete via isActive=false only.
