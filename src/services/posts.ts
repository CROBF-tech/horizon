import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { db } from '../db';
import { posts, postTags, tags, topics } from '../db/schema';
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
 * Status a post may have across its lifecycle.
 */
export type PostStatus = 'draft' | 'published' | 'archived';

/**
 * Optional fields accepted when creating or updating a post.
 */
export type PostInput = {
  title: string;
  excerpt?: string | null;
  content: string;
  coverImageUrl?: string | null;
  status?: PostStatus;
  topicId: number;
  tagSlugs?: string[];
  readingTimeMinutes?: number | null;
};

/**
 * Patch payload for partial updates. Fields left undefined are not modified.
 */
export type PostUpdate = Partial<PostInput> & { slug?: string };

/**
 * Full post row as persisted in the database.
 */
export type PostRecord = {
  id: number;
  slug: string;
  title: string;
  excerpt: string | null;
  content: string;
  coverImageUrl: string | null;
  status: PostStatus;
  topicId: number;
  readingTimeMinutes: number | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Lightweight metadata projection used in lists and previews. Excludes `content`.
 */
export type PostMetadata = Omit<PostRecord, 'content'> & {
  topic: { id: number; slug: string; name: string; kind: string };
  tags: Array<{ id: number; slug: string; name: string }>;
};

/**
 * Result of `getPostWithContent`: full body plus related entities.
 */
export type PostWithRelations = PostRecord & {
  topic: { id: number; slug: string; name: string; kind: string };
  tags: Array<{ id: number; slug: string; name: string }>;
};

const TITLE_MIN = 3;
const TITLE_MAX = 200;
const EXCERPT_MAX = 500;
const CONTENT_MIN = 1;

function mapRow(row: typeof posts.$inferSelect): PostRecord {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt,
    content: row.content,
    coverImageUrl: row.coverImageUrl,
    status: row.status,
    topicId: row.topicId,
    readingTimeMinutes: row.readingTimeMinutes,
    publishedAt: row.publishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function ensureTopicExists(
  topicId: number,
): Promise<Result<true, ServiceError>> {
  const found = await db
    .select({ id: topics.id })
    .from(topics)
    .where(eq(topics.id, topicId))
    .limit(1);
  if (found.length === 0) {
    return err('VALIDATION', `topic ${topicId} does not exist`);
  }
  return ok(true);
}

async function resolveTagIds(
  slugs: string[] | undefined,
): Promise<Result<number[], ServiceError>> {
  if (!slugs || slugs.length === 0) return ok([]);
  const rows = await db
    .select({ id: tags.id })
    .from(tags)
    .where(inArray(tags.slug, slugs));
  const found = new Set(rows.map((r) => r.id));
  const missing = slugs.filter((s) => ![...rows].some((r) => r.id));
  if (rows.length !== slugs.length) {
    return err(
      'VALIDATION',
      `unknown tag slug(s): ${missing.join(', ')}`,
    );
  }
  return ok([...found]);
}

/**
 * Publish a new post. Generates the slug, validates input, manages tags,
 * and stamps `publishedAt` if status is 'published'.
 *
 * @param input - Post payload from the caller.
 * @returns Result containing the created post record on success.
 */
export async function createPost(
  input: PostInput,
): Promise<Result<PostRecord, ServiceError>> {
  try {
    const title = (input.title ?? '').trim();
    if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
      return err(
        'VALIDATION',
        `title must be between ${TITLE_MIN} and ${TITLE_MAX} chars`,
      );
    }
    if (!input.content || input.content.length < CONTENT_MIN) {
      return err('VALIDATION', 'content is required');
    }
    if (typeof input.topicId !== 'number' || !Number.isInteger(input.topicId)) {
      return err('VALIDATION', 'topicId must be an integer');
    }
    if (input.excerpt && input.excerpt.length > EXCERPT_MAX) {
      return err('VALIDATION', `excerpt exceeds ${EXCERPT_MAX} chars`);
    }

    const topicCheck = await ensureTopicExists(input.topicId);
    if (!topicCheck.ok) return topicCheck;

    const tagsResult = await resolveTagIds(input.tagSlugs);
    if (!tagsResult.ok) return tagsResult;

    const slug = slugify(title);
    const status: PostStatus = input.status ?? 'draft';
    const now = new Date();
    const publishedAt = status === 'published' ? now : null;

    const inserted = await db
      .insert(posts)
      .values({
        slug,
        title,
        excerpt: input.excerpt ?? null,
        content: input.content,
        coverImageUrl: input.coverImageUrl ?? null,
        status,
        topicId: input.topicId,
        readingTimeMinutes: input.readingTimeMinutes ?? null,
        publishedAt,
      })
      .returning();

    const row = inserted[0];
    if (!row) {
      return err('DATABASE', 'insert returned no rows');
    }

    if (tagsResult.value.length > 0) {
      await db
        .insert(postTags)
        .values(tagsResult.value.map((tagId) => ({ postId: row.id, tagId })));
    }

    return ok(mapRow(row));
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes('UNIQUE')) {
      return err('CONFLICT', `post slug '${slugify(input.title ?? '')}' already exists`, cause);
    }
    return err('DATABASE', 'failed to create post', cause);
  }
}

/**
 * Update an existing post. Any subset of fields may be supplied; tags passed
 * in `tagSlugs` REPLACE existing associations for the post.
 *
 * @param id - Post id.
 * @param patch - Partial update payload.
 * @returns Result containing the updated post record on success.
 */
export async function updatePost(
  id: number,
  patch: PostUpdate,
): Promise<Result<PostRecord, ServiceError>> {
  try {
    const current = await getPostMetadataById(id);
    if (!current.ok) return current;

    const updates: Partial<typeof posts.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
        return err(
          'VALIDATION',
          `title must be between ${TITLE_MIN} and ${TITLE_MAX} chars`,
        );
      }
      updates.title = title;
      if (!patch.slug) updates.slug = slugify(title);
    }
    if (patch.slug !== undefined) {
      if (!/^[a-z0-9-]+$/.test(patch.slug)) {
        return err('VALIDATION', 'slug must match [a-z0-9-]+');
      }
      updates.slug = patch.slug;
    }
    if (patch.excerpt !== undefined) {
      if (patch.excerpt && patch.excerpt.length > EXCERPT_MAX) {
        return err('VALIDATION', `excerpt exceeds ${EXCERPT_MAX} chars`);
      }
      updates.excerpt = patch.excerpt ?? null;
    }
    if (patch.content !== undefined) {
      if (!patch.content || patch.content.length < CONTENT_MIN) {
        return err('VALIDATION', 'content is required');
      }
      updates.content = patch.content;
    }
    if (patch.coverImageUrl !== undefined) {
      updates.coverImageUrl = patch.coverImageUrl ?? null;
    }
    if (patch.status !== undefined) {
      updates.status = patch.status;
      if (patch.status === 'published' && !current.value.publishedAt) {
        updates.publishedAt = new Date();
      }
      if (patch.status !== 'published') {
        updates.publishedAt = null;
      }
    }
    if (patch.topicId !== undefined) {
      if (typeof patch.topicId !== 'number' || !Number.isInteger(patch.topicId)) {
        return err('VALIDATION', 'topicId must be an integer');
      }
      const topicCheck = await ensureTopicExists(patch.topicId);
      if (!topicCheck.ok) return topicCheck;
      updates.topicId = patch.topicId;
    }
    if (patch.readingTimeMinutes !== undefined) {
      updates.readingTimeMinutes = patch.readingTimeMinutes ?? null;
    }

    const updated = await db
      .update(posts)
      .set(updates)
      .where(eq(posts.id, id))
      .returning();
    const row = updated[0];
    if (!row) return err('NOT_FOUND', `post ${id} not found`);

    if (patch.tagSlugs) {
      const tagsResult = await resolveTagIds(patch.tagSlugs);
      if (!tagsResult.ok) return tagsResult;
      await db.delete(postTags).where(eq(postTags.postId, id));
      if (tagsResult.value.length > 0) {
        await db
          .insert(postTags)
          .values(tagsResult.value.map((tagId) => ({ postId: id, tagId })));
      }
    }

    return ok(mapRow(row));
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes('UNIQUE')) {
      return err('CONFLICT', 'post slug already in use', cause);
    }
    return err('DATABASE', `failed to update post ${id}`, cause);
  }
}

/**
 * Hard-delete a post and its tag associations.
 *
 * @param id - Post id.
 * @returns Result with a confirmation flag on success.
 */
export async function deletePost(
  id: number,
): Promise<Result<{ deleted: true; id: number }, ServiceError>> {
  try {
    const removed = await db
      .delete(posts)
      .where(eq(posts.id, id))
      .returning({ id: posts.id });
    if (removed.length === 0) {
      return err('NOT_FOUND', `post ${id} not found`);
    }
    return ok({ deleted: true, id });
  } catch (cause) {
    return err('DATABASE', `failed to delete post ${id}`, cause);
  }
}

/**
 * Publish a draft post: sets status='published' and stamps `publishedAt`.
 *
 * @param id - Post id.
 * @returns Result containing the updated post record.
 */
export async function publishPost(
  id: number,
): Promise<Result<PostRecord, ServiceError>> {
  return updatePost(id, { status: 'published' });
}

/**
 * Archive a previously published post.
 *
 * @param id - Post id.
 * @returns Result containing the updated post record.
 */
export async function archivePost(
  id: number,
): Promise<Result<PostRecord, ServiceError>> {
  return updatePost(id, { status: 'archived' });
}

/**
 * Unpublish a post, reverting it to draft.
 *
 * @param id - Post id.
 * @returns Result containing the updated post record.
 */
export async function unpublishPost(
  id: number,
): Promise<Result<PostRecord, ServiceError>> {
  return updatePost(id, { status: 'draft' });
}

/**
 * Fetch a single post by id, including content and relations.
 *
 * @param id - Post id.
 * @returns Result with the full post or NOT_FOUND.
 */
export async function getPostById(
  id: number,
): Promise<Result<PostWithRelations, ServiceError>> {
  try {
    const rows = await db
      .select({
        post: posts,
        topic: {
          id: topics.id,
          slug: topics.slug,
          name: topics.name,
          kind: topics.kind,
        },
      })
      .from(posts)
      .innerJoin(topics, eq(topics.id, posts.topicId))
      .where(eq(posts.id, id))
      .limit(1);

    const row = rows[0];
    if (!row) return err('NOT_FOUND', `post ${id} not found`);

    const tagRows = await db
      .select({ id: tags.id, slug: tags.slug, name: tags.name })
      .from(postTags)
      .innerJoin(tags, eq(tags.id, postTags.tagId))
      .where(eq(postTags.postId, id));

    return ok({
      ...mapRow(row.post),
      topic: row.topic,
      tags: tagRows,
    });
  } catch (cause) {
    return err('DATABASE', `failed to fetch post ${id}`, cause);
  }
}

/**
 * Fetch a single post by slug, including content and relations.
 *
 * @param slug - Post slug.
 * @returns Result with the full post or NOT_FOUND.
 */
export async function getPostBySlug(
  slug: string,
): Promise<Result<PostWithRelations, ServiceError>> {
  try {
    const found = await db
      .select({ id: posts.id })
      .from(posts)
      .where(eq(posts.slug, slug))
      .limit(1);
    if (found.length === 0) return err('NOT_FOUND', `post '${slug}' not found`);
    const [id] = found;
    return getPostById(id.id);
  } catch (cause) {
    return err('DATABASE', `failed to fetch post '${slug}'`, cause);
  }
}

/**
 * Fetch post metadata (no content body) by id.
 *
 * @param id - Post id.
 * @returns Result with metadata or NOT_FOUND.
 */
export async function getPostMetadataById(
  id: number,
): Promise<Result<PostMetadata, ServiceError>> {
  try {
    const row = await db
      .select({
        post: posts,
        topic: {
          id: topics.id,
          slug: topics.slug,
          name: topics.name,
          kind: topics.kind,
        },
      })
      .from(posts)
      .innerJoin(topics, eq(topics.id, posts.topicId))
      .where(eq(posts.id, id))
      .limit(1)
      .then((r) => r[0]);

    if (!row) return err('NOT_FOUND', `post ${id} not found`);

    const tagRows = await db
      .select({ id: tags.id, slug: tags.slug, name: tags.name })
      .from(postTags)
      .innerJoin(tags, eq(tags.id, postTags.tagId))
      .where(eq(postTags.postId, id));

    const { content, ...rest } = mapRow(row.post);
    void content;
    return ok({ ...rest, topic: row.topic, tags: tagRows });
  } catch (cause) {
    return err('DATABASE', `failed to fetch metadata for post ${id}`, cause);
  }
}

/**
 * Fetch post metadata (no content body) by slug.
 *
 * @param slug - Post slug.
 * @returns Result with metadata or NOT_FOUND.
 */
export async function getPostMetadataBySlug(
  slug: string,
): Promise<Result<PostMetadata, ServiceError>> {
  try {
    const found = await db
      .select({ id: posts.id })
      .from(posts)
      .where(eq(posts.slug, slug))
      .limit(1);
    if (found.length === 0) return err('NOT_FOUND', `post '${slug}' not found`);
    const [id] = found;
    return getPostMetadataById(id.id);
  } catch (cause) {
    return err('DATABASE', `failed to fetch metadata for '${slug}'`, cause);
  }
}

/**
 * Paginated list of post metadata, newest first.
 *
 * @param options - Pagination options.
 * @returns Result with a Page of metadata records.
 */
export async function listPosts(
  options?: PaginationOptions,
): Promise<Result<Page<PostMetadata>, ServiceError>> {
  return listPostsByStatus(undefined, options);
}

/**
 * Paginated list of metadata filtered by status. Omit `status` to see all.
 *
 * @param status - Optional status filter.
 * @param options - Pagination options.
 * @returns Result with a Page of metadata records.
 */
export async function listPostsByStatus(
  status: PostStatus | undefined,
  options?: PaginationOptions,
): Promise<Result<Page<PostMetadata>, ServiceError>> {
  try {
    const { page, pageSize } = normalizePagination(options);
    const offset = (page - 1) * pageSize;
    const filters = status ? eq(posts.status, status) : undefined;

    const totalRows = await db
      .select({ c: sql<number>`count(*)` })
      .from(posts)
      .where(filters ?? sql`1=1`);
    const total = Number(totalRows[0]?.c ?? 0);

    const rows = await db
      .select({
        post: posts,
        topic: {
          id: topics.id,
          slug: topics.slug,
          name: topics.name,
          kind: topics.kind,
        },
      })
      .from(posts)
      .innerJoin(topics, eq(topics.id, posts.topicId))
      .where(filters ?? sql`1=1`)
      .orderBy(desc(posts.publishedAt), desc(posts.createdAt))
      .limit(pageSize)
      .offset(offset);

    const ids = rows.map((r) => r.post.id);
    const tagRows = ids.length
      ? await db
          .select({
            postId: postTags.postId,
            id: tags.id,
            slug: tags.slug,
            name: tags.name,
          })
          .from(postTags)
          .innerJoin(tags, eq(tags.id, postTags.tagId))
          .where(inArray(postTags.postId, ids))
      : [];

    const tagsByPost = new Map<number, Array<{ id: number; slug: string; name: string }>>();
    for (const t of tagRows) {
      const bucket = tagsByPost.get(t.postId) ?? [];
      bucket.push({ id: t.id, slug: t.slug, name: t.name });
      tagsByPost.set(t.postId, bucket);
    }

    const items: PostMetadata[] = rows.map((r) => {
      const { content, ...rest } = mapRow(r.post);
      void content;
      return {
        ...rest,
        topic: r.topic,
        tags: tagsByPost.get(r.post.id) ?? [],
      };
    });

    return ok(buildPage(items, total, page, pageSize));
  } catch (cause) {
    return err('DATABASE', 'failed to list posts', cause);
  }
}

/**
 * Paginated metadata list for a given topic.
 *
 * @param topicId - Topic id.
 * @param options - Pagination options.
 * @returns Result with a Page of metadata records.
 */
export async function listPostsByTopic(
  topicId: number,
  options?: PaginationOptions,
): Promise<Result<Page<PostMetadata>, ServiceError>> {
  try {
    const { page, pageSize } = normalizePagination(options);
    const offset = (page - 1) * pageSize;

    const totalRows = await db
      .select({ c: sql<number>`count(*)` })
      .from(posts)
      .where(eq(posts.topicId, topicId));
    const total = Number(totalRows[0]?.c ?? 0);

    const rows = await db
      .select({
        post: posts,
        topic: {
          id: topics.id,
          slug: topics.slug,
          name: topics.name,
          kind: topics.kind,
        },
      })
      .from(posts)
      .innerJoin(topics, eq(topics.id, posts.topicId))
      .where(eq(posts.topicId, topicId))
      .orderBy(desc(posts.publishedAt), desc(posts.createdAt))
      .limit(pageSize)
      .offset(offset);

    return ok(buildPage(rows.map((r) => {
      const { content, ...rest } = mapRow(r.post);
      void content;
      return { ...rest, topic: r.topic, tags: [] };
    }), total, page, pageSize));
  } catch (cause) {
    return err('DATABASE', `failed to list posts for topic ${topicId}`, cause);
  }
}

/**
 * Cursor-based pagination by createdAt cursor, ordered oldest -> newest.
 * Use when streaming exports or infinite scroll that must not skip or duplicate.
 *
 * @param cursor - Lower bound (exclusive) for createdAt; omit to start from the beginning.
 * @param limit  - Page size (capped to MAX_PAGE_SIZE).
 * @returns Result with the page items and the next cursor (null when no more).
 */
export async function listPostsAfter(
  cursor: Date | null,
  limit?: number,
): Promise<
  Result<{ items: PostMetadata[]; nextCursor: Date | null }, ServiceError>
> {
  try {
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, limit ?? DEFAULT_PAGE_SIZE));
    const rows = await db
      .select({
        post: posts,
        topic: {
          id: topics.id,
          slug: topics.slug,
          name: topics.name,
          kind: topics.kind,
        },
      })
      .from(posts)
      .innerJoin(topics, eq(topics.id, posts.topicId))
      .where(cursor ? lt(posts.createdAt, cursor) : sql`1=1`)
      .orderBy(desc(posts.createdAt))
      .limit(pageSize + 1);

    const hasMore = rows.length > pageSize;
    const slice = hasMore ? rows.slice(0, pageSize) : rows;
    const items: PostMetadata[] = slice.map((r) => {
      const { content, ...rest } = mapRow(r.post);
      void content;
      return { ...rest, topic: r.topic, tags: [] };
    });
    const nextCursor = hasMore
      ? slice[slice.length - 1]!.post.createdAt
      : null;
    return ok({ items, nextCursor });
  } catch (cause) {
    return err('DATABASE', 'failed to cursor-list posts', cause);
  }
}

/**
 * Count posts grouped by status. Useful for admin dashboards.
 *
 * @returns Result with counts map.
 */
export async function countPostsByStatus(): Promise<
  Result<Record<PostStatus, number>, ServiceError>
> {
  try {
    const rows = await db
      .select({ status: posts.status, c: sql<number>`count(*)` })
      .from(posts)
      .groupBy(posts.status);
    const out: Record<PostStatus, number> = {
      draft: 0,
      published: 0,
      archived: 0,
    };
    for (const r of rows) out[r.status] = Number(r.c);
    return ok(out);
  } catch (cause) {
    return err('DATABASE', 'failed to count posts by status', cause);
  }
}

/**
 * Check whether a slug is available (no existing post uses it).
 *
 * @param slug - Slug to test.
 * @returns Result with boolean.
 */
export async function isSlugAvailable(
  slug: string,
): Promise<Result<boolean, ServiceError>> {
  try {
    const found = await db
      .select({ id: posts.id })
      .from(posts)
      .where(eq(posts.slug, slug))
      .limit(1);
    return ok(found.length === 0);
  } catch (cause) {
    return err('DATABASE', `failed to check slug '${slug}'`, cause);
  }
}

/**
 * Attach a tag (by id) to a post. No-op if already attached.
 *
 * @param postId - Post id.
 * @param tagId - Tag id.
 * @returns Result with the new association status.
 */
export async function attachTagToPost(
  postId: number,
  tagId: number,
): Promise<Result<{ attached: boolean }, ServiceError>> {
  try {
    const exists = await db
      .select()
      .from(postTags)
      .where(
        and(eq(postTags.postId, postId), eq(postTags.tagId, tagId)),
      )
      .limit(1);
    if (exists.length > 0) return ok({ attached: false });
    await db.insert(postTags).values({ postId, tagId });
    return ok({ attached: true });
  } catch (cause) {
    return err('DATABASE', 'failed to attach tag', cause);
  }
}

/**
 * Detach a tag (by id) from a post. No-op if not attached.
 *
 * @param postId - Post id.
 * @param tagId - Tag id.
 * @returns Result with the detach status.
 */
export async function detachTagFromPost(
  postId: number,
  tagId: number,
): Promise<Result<{ detached: boolean }, ServiceError>> {
  try {
    const removed = await db
      .delete(postTags)
      .where(
        and(eq(postTags.postId, postId), eq(postTags.tagId, tagId)),
      )
      .returning();
    return ok({ detached: removed.length > 0 });
  } catch (cause) {
    return err('DATABASE', 'failed to detach tag', cause);
  }
}
