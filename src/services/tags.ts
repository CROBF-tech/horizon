import { asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { tags } from '../db/schema';
import {
  buildPage,
  err,
  normalizePagination,
  ok,
  slugify,
  type Page,
  type PaginationOptions,
  type Result,
  type ServiceError,
} from './types';

/**
 * Persisted tag row.
 */
export type TagRecord = {
  id: number;
  slug: string;
  name: string;
  createdAt: Date;
};

/**
 * Input for creating a tag.
 */
export type TagInput = {
  name: string;
};

/**
 * Patch payload for partial updates.
 */
export type TagUpdate = Partial<TagInput> & { slug?: string };

function mapRow(row: typeof tags.$inferSelect): TagRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    createdAt: row.createdAt,
  };
}

/**
 * Create a new tag, generating the slug from the name.
 *
 * @param input - Tag payload.
 * @returns Result with the created tag.
 */
export async function createTag(
  input: TagInput,
): Promise<Result<TagRecord, ServiceError>> {
  try {
    const name = (input.name ?? '').trim();
    if (name.length < 1 || name.length > 40) {
      return err('VALIDATION', 'name must be 1..40 chars');
    }
    const slug = slugify(name);
    const inserted = await db
      .insert(tags)
      .values({ name, slug })
      .returning();
    const row = inserted[0];
    if (!row) return err('DATABASE', 'insert returned no rows');
    return ok(mapRow(row));
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes('UNIQUE')) {
      return err('CONFLICT', `tag slug already exists`, cause);
    }
    return err('DATABASE', 'failed to create tag', cause);
  }
}

/**
 * Patch an existing tag.
 *
 * @param id - Tag id.
 * @param patch - Fields to update.
 * @returns Result with the updated tag.
 */
export async function updateTag(
  id: number,
  patch: TagUpdate,
): Promise<Result<TagRecord, ServiceError>> {
  try {
    const updates: Partial<typeof tags.$inferInsert> = {};
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (name.length < 1 || name.length > 40) {
        return err('VALIDATION', 'name must be 1..40 chars');
      }
      updates.name = name;
      if (!patch.slug) updates.slug = slugify(name);
    }
    if (patch.slug !== undefined) {
      if (!/^[a-z0-9-]+$/.test(patch.slug)) {
        return err('VALIDATION', 'slug must match [a-z0-9-]+');
      }
      updates.slug = patch.slug;
    }

    if (Object.keys(updates).length === 0) {
      const current = await getTagById(id);
      return current;
    }

    const updated = await db
      .update(tags)
      .set(updates)
      .where(eq(tags.id, id))
      .returning();
    const row = updated[0];
    if (!row) return err('NOT_FOUND', `tag ${id} not found`);
    return ok(mapRow(row));
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes('UNIQUE')) {
      return err('CONFLICT', 'tag slug already in use', cause);
    }
    return err('DATABASE', `failed to update tag ${id}`, cause);
  }
}

/**
 * Delete a tag. Cascade removes post_tag associations.
 *
 * @param id - Tag id.
 * @returns Result with confirmation.
 */
export async function deleteTag(
  id: number,
): Promise<Result<{ deleted: true; id: number }, ServiceError>> {
  try {
    const removed = await db
      .delete(tags)
      .where(eq(tags.id, id))
      .returning({ id: tags.id });
    if (removed.length === 0) {
      return err('NOT_FOUND', `tag ${id} not found`);
    }
    return ok({ deleted: true, id });
  } catch (cause) {
    return err('DATABASE', `failed to delete tag ${id}`, cause);
  }
}

/**
 * Fetch a tag by id.
 *
 * @param id - Tag id.
 * @returns Result with the tag or NOT_FOUND.
 */
export async function getTagById(
  id: number,
): Promise<Result<TagRecord, ServiceError>> {
  try {
    const rows = await db
      .select()
      .from(tags)
      .where(eq(tags.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return err('NOT_FOUND', `tag ${id} not found`);
    return ok(mapRow(row));
  } catch (cause) {
    return err('DATABASE', `failed to fetch tag ${id}`, cause);
  }
}

/**
 * Fetch a tag by slug.
 *
 * @param slug - Tag slug.
 * @returns Result with the tag or NOT_FOUND.
 */
export async function getTagBySlug(
  slug: string,
): Promise<Result<TagRecord, ServiceError>> {
  try {
    const rows = await db
      .select()
      .from(tags)
      .where(eq(tags.slug, slug))
      .limit(1);
    const row = rows[0];
    if (!row) return err('NOT_FOUND', `tag '${slug}' not found`);
    return ok(mapRow(row));
  } catch (cause) {
    return err('DATABASE', `failed to fetch tag '${slug}'`, cause);
  }
}

/**
 * Paginated list of tags, alphabetical by name.
 *
 * @param options - Pagination options.
 * @returns Result with a Page of tags.
 */
export async function listTags(
  options?: PaginationOptions,
): Promise<Result<Page<TagRecord>, ServiceError>> {
  try {
    const { page, pageSize } = normalizePagination(options);
    const offset = (page - 1) * pageSize;
    const totalRows = await db.select({ id: tags.id }).from(tags);
    const total = totalRows.length;
    const rows = await db
      .select()
      .from(tags)
      .orderBy(asc(tags.name))
      .limit(pageSize)
      .offset(offset);
    return ok(buildPage(rows.map(mapRow), total, page, pageSize));
  } catch (cause) {
    return err('DATABASE', 'failed to list tags', cause);
  }
}

/**
 * Fetch many tags by id in a single query.
 *
 * @param ids - Tag ids.
 * @returns Result with the matching tags (in the order returned by DB).
 */
export async function getTagsByIds(
  ids: number[],
): Promise<Result<TagRecord[], ServiceError>> {
  try {
    if (ids.length === 0) return ok([]);
    const rows = await db.select().from(tags).where(inArray(tags.id, ids));
    return ok(rows.map(mapRow));
  } catch (cause) {
    return err('DATABASE', 'failed to fetch tags by ids', cause);
  }
}

/**
 * Fetch many tags by slug in a single query.
 *
 * @param slugs - Tag slugs.
 * @returns Result with the matching tags (in the order returned by DB).
 */
export async function getTagsBySlugs(
  slugs: string[],
): Promise<Result<TagRecord[], ServiceError>> {
  try {
    if (slugs.length === 0) return ok([]);
    const rows = await db.select().from(tags).where(inArray(tags.slug, slugs));
    return ok(rows.map(mapRow));
  } catch (cause) {
    return err('DATABASE', 'failed to fetch tags by slugs', cause);
  }
}

/**
 * Check whether a tag slug is available.
 *
 * @param slug - Slug to test.
 * @returns Result with boolean.
 */
export async function isTagSlugAvailable(
  slug: string,
): Promise<Result<boolean, ServiceError>> {
  try {
    const found = await db
      .select({ id: tags.id })
      .from(tags)
      .where(eq(tags.slug, slug))
      .limit(1);
    return ok(found.length === 0);
  } catch (cause) {
    return err('DATABASE', `failed to check tag slug '${slug}'`, cause);
  }
}
