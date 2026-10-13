import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { jsonObjectFrom } from 'kysely/helpers/postgres';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { AttachmentType } from '../attachment/attachment.constants';
import { AttachmentSearchDto } from './dto/attachment-search.dto';

@Injectable()
export class AttachmentSearchService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly spaceMembers: SpaceMemberRepo,
  ) {}

  async search(
    input: AttachmentSearchDto,
    identity: { userId: string; workspaceId: string },
  ) {
    const keyword = input.query?.trim();
    if (!keyword) return { items: [] };
    const { userId, workspaceId } = identity;
    const pattern = `%${keyword.replace(/[\\%_]/g, '\\$&')}%`;

    // Candidate discovery and inherited permission checks share one DB snapshot.
    // Like PagePermissionRepo, every restricted ancestor must grant access to
    // this user directly or through a group. Space membership is also required.
    const query = this.db
      .withRecursive('attachmentCandidates', (db) =>
        db
          .selectFrom('attachments')
          .innerJoin('pages', 'pages.id', 'attachments.pageId')
          .select('pages.id as pageId')
          .distinct()
          .where('attachments.workspaceId', '=', workspaceId)
          .where('pages.workspaceId', '=', workspaceId)
          .whereRef('attachments.spaceId', '=', 'pages.spaceId')
          .where(
            'pages.spaceId',
            'in',
            this.spaceMembers.getUserSpaceIdsQuery(userId),
          )
          .where('attachments.type', '=', AttachmentType.File)
          .where('attachments.deletedAt', 'is', null)
          .where('pages.deletedAt', 'is', null)
          .$if(Boolean(input.spaceId), (qb) =>
            qb.where('pages.spaceId', '=', input.spaceId),
          )
          .$if(Boolean(input.creatorId), (qb) =>
            qb.where('attachments.creatorId', '=', input.creatorId),
          )
          .where((eb) =>
            eb.or([
              eb('attachments.fileName', 'ilike', pattern),
              eb('attachments.textContent', 'ilike', pattern),
            ]),
          ),
      )
      .withRecursive('attachmentAncestors', (db) =>
        db
          .selectFrom('pages')
          .innerJoin(
            'attachmentCandidates',
            'attachmentCandidates.pageId',
            'pages.id',
          )
          .select([
            'pages.id as pageId',
            'pages.id as ancestorId',
            'pages.parentPageId',
            'pages.deletedAt',
          ])
          .unionAll((db) =>
            db
              .selectFrom('pages')
              .innerJoin(
                'attachmentAncestors',
                'attachmentAncestors.parentPageId',
                'pages.id',
              )
              .select([
                'attachmentAncestors.pageId',
                'pages.id as ancestorId',
                'pages.parentPageId',
                'pages.deletedAt',
              ])
              .where('pages.workspaceId', '=', workspaceId),
          ),
      )
      .selectFrom('attachments')
      .innerJoin('pages', 'pages.id', 'attachments.pageId')
      .select([
        'attachments.id',
        'attachments.fileName',
        'attachments.pageId',
        'attachments.creatorId',
        'attachments.createdAt',
        'attachments.updatedAt',
      ])
      .select((eb) => [
        jsonObjectFrom(
          eb
            .selectFrom('spaces')
            .select(['spaces.id', 'spaces.name', 'spaces.slug'])
            .whereRef('spaces.id', '=', 'pages.spaceId'),
        ).as('space'),
        jsonObjectFrom(
          eb
            .selectFrom('pages as attachmentPage')
            .select([
              'attachmentPage.id',
              'attachmentPage.title',
              'attachmentPage.slugId',
            ])
            .whereRef('attachmentPage.id', '=', 'attachments.pageId'),
        ).as('page'),
      ])
      .where('attachments.workspaceId', '=', workspaceId)
      .where('pages.workspaceId', '=', workspaceId)
      .whereRef('attachments.spaceId', '=', 'pages.spaceId')
      .where('pages.id', 'in', (eb) =>
        eb.selectFrom('attachmentCandidates').select('pageId'),
      )
      .where('attachments.type', '=', AttachmentType.File)
      .where('attachments.deletedAt', 'is', null)
      .where('pages.deletedAt', 'is', null)
      .$if(Boolean(input.creatorId), (qb) =>
        qb.where('attachments.creatorId', '=', input.creatorId),
      )
      .where((eb) =>
        eb.or([
          eb('attachments.fileName', 'ilike', pattern),
          eb('attachments.textContent', 'ilike', pattern),
        ]),
      )
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('attachmentAncestors')
              .innerJoin(
                'pageAccess',
                'pageAccess.pageId',
                'attachmentAncestors.ancestorId',
              )
              .leftJoin('pagePermissions', (join) =>
                join
                  .onRef('pagePermissions.pageAccessId', '=', 'pageAccess.id')
                  .on((eb) =>
                    eb.or([
                      eb('pagePermissions.userId', '=', userId),
                      eb(
                        'pagePermissions.groupId',
                        'in',
                        eb
                          .selectFrom('groupUsers')
                          .select('groupId')
                          .where('userId', '=', userId),
                      ),
                    ]),
                  ),
              )
              .select('pageAccess.pageId')
              .whereRef('attachmentAncestors.pageId', '=', 'pages.id')
              .where('pagePermissions.id', 'is', null),
          ),
        ),
      )
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('attachmentAncestors')
              .select('ancestorId')
              .whereRef('attachmentAncestors.pageId', '=', 'pages.id')
              .where('deletedAt', 'is not', null),
          ),
        ),
      )
      .orderBy('attachments.updatedAt', 'desc')
      .orderBy('attachments.id', 'asc')
      .limit(input.limit ?? 20)
      .offset(input.offset ?? 0);

    return { items: await query.execute() };
  }
}
