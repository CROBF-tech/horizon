import { asc, eq } from 'drizzle-orm';
import { db } from '../db';
import { topics } from '../db/schema';
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
 * Allowed values for `topics.kind`. Matches the schema enum.
 */
export const TOPIC_KINDS = [
  'tutorial',
  'news',
  'blog',
  'story',
  'tip',
  'opinion',
  'other',
] as const;

export type TopicKind = (typeof TOPIC_KINDS)[number];

/**
 * Persisted topic row.
 */
export type TopicRecord = {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  kind: TopicKind;
  createdAt: Date;
};

/**
 * Input for creating a topic.
 */
export type TopicInput = {
  name: string;
  description?: string | null;
  kind?: TopicKind;
};

/**
 * Patch payload for partial updates.
 */
export type TopicUpdate = Partial<TopicInput> & { slug?: string };

function mapRow(row: typeof topics.$inferSelect): TopicRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    kind: row.kind,
    createdAt: row.createdAt,
  };
}

function validateKind(kind: string): Result<TopicKind, ServiceError> {
  if ((TOPIC_KINDS as readonly string[]).includes(kind)) {
    return ok(kind as TopicKind);
  }
  return err('VALIDATION', `kind must be one of: ${TOPIC_KINDS.join(', ')}`);
}

/**
 * Create a new topic.
 *
 * @param input - Topic payload.
 * @returns Result with the created topic record.
 */
export async function createTopic(
  input: TopicInput,
): Promise<Result<TopicRecord, ServiceError>> {
  try {
    const name = (input.name ?? '').trim();
    if (name.length < 2 || name.length > 80) {
      return err('VALIDATION', 'name must be 2..80 chars');
    }
    const kind: TopicKind = input.kind ?? 'blog';
    const kindCheck = validateKind(kind);
    if (!kindCheck.ok) return kindCheck;

    const inserted = await db
      .insert(topics)
      .values({
        name,
        slug: slugify(name),
        description: input.description ?? null,
        kind: kindCheck.value,
      })
      .returning();
    const row = inserted[0];
    if (!row) return err('DATABASE', 'insert returned no rows');
    return ok(mapRow(row));
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes('UNIQUE')) {
      return err('CONFLICT', `topic slug already exists`, cause);
    }
    return err('DATABASE', 'failed to create topic', cause);
  }
}

/**
 * Patch an existing topic.
 *
 * @param id - Topic id.
 * @param patch - Fields to update.
 * @returns Result with the updated topic.
 */
export async function updateTopic(
  id: number,
  patch: TopicUpdate,
): Promise<Result<TopicRecord, ServiceError>> {
  try {
    const updates: Partial<typeof topics.$inferInsert> = {};
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (name.length < 2 || name.length > 80) {
        return err('VALIDATION', 'name must be 2..80 chars');
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
    if (patch.description !== undefined) {
      updates.description = patch.description ?? null;
    }
    if (patch.kind !== undefined) {
      const kindCheck = validateKind(patch.kind);
      if (!kindCheck.ok) return kindCheck;
      updates.kind = kindCheck.value;
    }

    if (Object.keys(updates).length === 0) {
      const current = await getTopicById(id);
      return current;
    }

    const updated = await db
      .update(topics)
      .set(updates)
      .where(eq(topics.id, id))
      .returning();
    const row = updated[0];
    if (!row) return err('NOT_FOUND', `topic ${id} not found`);
    return ok(mapRow(row));
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes('UNIQUE')) {
      return err('CONFLICT', 'topic slug already in use', cause);
    }
    return err('DATABASE', `failed to update topic ${id}`, cause);
  }
}

/**
 * Delete a topic. Fails (VALIDATION) if posts still reference it.
 *
 * @param id - Topic id.
 * @returns Result with confirmation.
 */
export async function deleteTopic(
  id: number,
): Promise<Result<{ deleted: true; id: number }, ServiceError>> {
  try {
    const removed = await db
      .delete(topics)
      .where(eq(topics.id, id))
      .returning({ id: topics.id });
    if (removed.length === 0) {
      return err('NOT_FOUND', `topic ${id} not found`);
    }
    return ok({ deleted: true, id });
  } catch (cause) {
    return cause instanceof Error && cause.message.includes('FOREIGN')
      ? err('CONFLICT', 'topic has posts; cannot delete', cause)
      : err('DATABASE', `failed to delete topic ${id}`, cause);
  }
}

/**
 * Fetch a topic by id.
 *
 * @param id - Topic id.
 * @returns Result with the topic or NOT_FOUND.
 */
export async function getTopicById(
  id: number,
): Promise<Result<TopicRecord, ServiceError>> {
  try {
    const rows = await db
      .select()
      .from(topics)
      .where(eq(topics.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return err('NOT_FOUND', `topic ${id} not found`);
    return ok(mapRow(row));
  } catch (cause) {
    return err('DATABASE', `failed to fetch topic ${id}`, cause);
  }
}

/**
 * Fetch a topic by slug.
 *
 * @param slug - Topic slug.
 * @returns Result with the topic or NOT_FOUND.
 */
export async function getTopicBySlug(
  slug: string,
): Promise<Result<TopicRecord, ServiceError>> {
  try {
    const rows = await db
      .select()
      .from(topics)
      .where(eq(topics.slug, slug))
      .limit(1);
    const row = rows[0];
    if (!row) return err('NOT_FOUND', `topic '${slug}' not found`);
    return ok(mapRow(row));
  } catch (cause) {
    return err('DATABASE', `failed to fetch topic '${slug}'`, cause);
  }
}

/**
 * Paginated list of topics, alphabetical by name.
 *
 * @param options - Pagination options.
 * @returns Result with a Page of topics.
 */
export async function listTopics(
  options?: PaginationOptions,
): Promise<Result<Page<TopicRecord>, ServiceError>> {
  try {
    const { page, pageSize } = normalizePagination(options);
    const offset = (page - 1) * pageSize;
    const totalRows = await db.select({ id: topics.id }).from(topics);
    const total = totalRows.length;
    const rows = await db
      .select()
      .from(topics)
      .orderBy(asc(topics.name))
      .limit(pageSize)
      .offset(offset);
    return ok(buildPage(rows.map(mapRow), total, page, pageSize));
  } catch (cause) {
    return err('DATABASE', 'failed to list topics', cause);
  }
}

/**
 * List all topics of a given kind (no pagination).
 *
 * @param kind - Topic kind to filter by.
 * @returns Result with the matching topics.
 */
export async function listTopicsByKind(
  kind: TopicKind,
): Promise<Result<TopicRecord[], ServiceError>> {
  try {
    const kindCheck = validateKind(kind);
    if (!kindCheck.ok) return kindCheck;
    const rows = await db
      .select()
      .from(topics)
      .where(eq(topics.kind, kindCheck.value))
      .orderBy(asc(topics.name));
    return ok(rows.map(mapRow));
  } catch (cause) {
    return err('DATABASE', `failed to list topics of kind '${kind}'`, cause);
  }
}

/**
 * Check whether a topic slug is available.
 *
 * @param slug - Slug to test.
 * @returns Result with boolean.
 */
export async function isTopicSlugAvailable(
  slug: string,
): Promise<Result<boolean, ServiceError>> {
  try {
    const found = await db
      .select({ id: topics.id })
      .from(topics)
      .where(eq(topics.slug, slug))
      .limit(1);
    return ok(found.length === 0);
  } catch (cause) {
    return err('DATABASE', `failed to check topic slug '${slug}'`, cause);
  }
}
