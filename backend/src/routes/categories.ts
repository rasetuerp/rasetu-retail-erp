import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requireCompanyDb, requireRole } from '../lib/auth-middleware.js';
import { asyncHandler } from '../lib/async-handler.js';
import { HttpError } from '../lib/http-error.js';
import { abbreviateToCode, uniqueCode } from '../lib/code-gen.js';

// Round 11 — the item Category master (name + short code), backing the
// searchable Category picker on Item Master / Bulk Stock Entry and the
// CategoryCode segment of auto-generated SKUs (see items.ts's /next-sku).
// Stored as a Setting-JSON list, same pattern as item-fields/payment-modes —
// `Item.category` itself stays a plain string column (picking a category just
// fills it with that category's name), so nothing about how category is read
// elsewhere in the app changes.

export const categoriesRouter = Router({ mergeParams: true });

const CATEGORIES_KEY = 'item-categories';

const categoryEntrySchema = z.object({ name: z.string().min(1), code: z.string().min(1) });
const categoriesSettingSchema = z.object({ list: z.array(categoryEntrySchema).default([]) });
type CategoryEntry = z.infer<typeof categoryEntrySchema>;

categoriesRouter.use(requireAuth);

// Loads the company's category list, auto-seeding it from distinct existing
// Item.category text values the first time it's ever requested — so a shop
// that already has items typed with free-text categories sees them in the
// new picker immediately, with zero manual re-entry.
async function loadCategories(prisma: ReturnType<typeof requireCompanyDb>, companyId: string): Promise<CategoryEntry[]> {
  const setting = await prisma.setting.findUnique({
    where: { companyId_key: { companyId, key: CATEGORIES_KEY } },
  });
  if (setting) return categoriesSettingSchema.parse(JSON.parse(setting.value)).list;

  const rows = await prisma.item.findMany({
    where: { companyId, category: { not: null } },
    select: { category: true },
    distinct: ['category'],
  });
  const names = rows.map((r) => r.category?.trim()).filter((n): n is string => !!n);

  const list: CategoryEntry[] = [];
  for (const name of names) {
    const code = uniqueCode(abbreviateToCode(name), list.map((c) => c.code));
    list.push({ name, code });
  }

  await prisma.setting.upsert({
    where: { companyId_key: { companyId, key: CATEGORIES_KEY } },
    create: { companyId, key: CATEGORIES_KEY, value: JSON.stringify({ list }) },
    update: { value: JSON.stringify({ list }) },
  });
  return list;
}

async function saveCategories(prisma: ReturnType<typeof requireCompanyDb>, companyId: string, list: CategoryEntry[]) {
  await prisma.setting.upsert({
    where: { companyId_key: { companyId, key: CATEGORIES_KEY } },
    create: { companyId, key: CATEGORIES_KEY, value: JSON.stringify({ list }) },
    update: { value: JSON.stringify({ list }) },
  });
}

categoriesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const categories = await loadCategories(prisma, req.params.companyId);
    res.json({ categories });
  })
);

const createCategorySchema = z.object({ name: z.string().min(1), code: z.string().min(1).optional() });

categoriesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const input = createCategorySchema.parse(req.body);
    const list = await loadCategories(prisma, req.params.companyId);

    if (list.some((c) => c.name.toLowerCase() === input.name.toLowerCase())) {
      throw new HttpError(400, `Category "${input.name}" already exists.`);
    }

    let code: string;
    if (input.code) {
      code = input.code.toUpperCase();
      if (list.some((c) => c.code.toUpperCase() === code)) {
        throw new HttpError(400, `Category code "${code}" is already used by another category.`);
      }
    } else {
      code = uniqueCode(abbreviateToCode(input.name), list.map((c) => c.code));
    }

    const entry: CategoryEntry = { name: input.name, code };
    const next = [...list, entry];
    await saveCategories(prisma, req.params.companyId, next);
    res.status(201).json({ categories: next, category: entry });
  })
);

const updateCategorySchema = z.object({ name: z.string().min(1).optional(), code: z.string().min(1).optional() });

categoriesRouter.patch(
  '/:code',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const input = updateCategorySchema.parse(req.body);
    const list = await loadCategories(prisma, req.params.companyId);
    const targetCode = req.params.code.toUpperCase();
    const idx = list.findIndex((c) => c.code.toUpperCase() === targetCode);
    if (idx === -1) throw new HttpError(404, 'Category not found');

    if (input.name && list.some((c, i) => i !== idx && c.name.toLowerCase() === input.name!.toLowerCase())) {
      throw new HttpError(400, `Category "${input.name}" already exists.`);
    }
    const newCode = input.code ? input.code.toUpperCase() : list[idx].code;
    if (input.code && list.some((c, i) => i !== idx && c.code.toUpperCase() === newCode)) {
      throw new HttpError(400, `Category code "${newCode}" is already used by another category.`);
    }

    const next = list.slice();
    next[idx] = { name: input.name ?? list[idx].name, code: newCode };
    await saveCategories(prisma, req.params.companyId, next);
    res.json({ categories: next });
  })
);

categoriesRouter.delete(
  '/:code',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    const prisma = requireCompanyDb(req);
    const list = await loadCategories(prisma, req.params.companyId);
    const targetCode = req.params.code.toUpperCase();
    const next = list.filter((c) => c.code.toUpperCase() !== targetCode);
    await saveCategories(prisma, req.params.companyId, next);
    res.json({ categories: next });
  })
);
