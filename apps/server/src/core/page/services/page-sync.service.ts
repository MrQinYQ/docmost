import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { Page, User } from '@docmost/db/types/entity.types';
import { PageAccessService } from '../page-access/page-access.service';
import { CollaborationGateway } from '../../../collaboration/collaboration.gateway';
import {
  parseSyncMarkdown,
  revisionForContent,
} from '../../../collaboration/sync-revision.util';
import { SyncPageStateDto, SyncPageUpdateDto } from '../dto/sync-page.dto';
import { SyncEventResult } from '../../../collaboration/sync.types';

@Injectable()
export class PageSyncService {
  constructor(
    private readonly pageRepo: PageRepo,
    private readonly pageAccessService: PageAccessService,
    private readonly collaborationGateway: CollaborationGateway,
  ) {}

  private async target(pageId: string, user: User): Promise<Page> {
    const page = await this.pageRepo.findById(pageId);
    if (!page || page.deletedAt || page.workspaceId !== user.workspaceId)
      throw new NotFoundException('Page not found');
    return page;
  }

  async state(dto: SyncPageStateDto, user: User) {
    const page = await this.target(dto.pageId, user);
    await this.pageAccessService.validateCanView(page, user);
    const proposedRevision =
      dto.content !== undefined
        ? revisionForContent(await parseSyncMarkdown(dto.content))
        : undefined;
    let result: SyncEventResult;
    try {
      result = await this.collaborationGateway.handleYjsEvent(
        'getPageSyncState',
        `page.${page.id}`,
        {
          pageId: page.id,
          spaceId: page.spaceId,
          workspaceId: page.workspaceId,
          user,
        },
      );
    } catch {
      throw new ServiceUnavailableException({
        code: 'UNCONFIRMED',
        message: 'Unable to confirm the live page state',
      });
    }
    return {
      ...this.result(page, result),
      ...(proposedRevision ? { proposedRevision } : {}),
    };
  }

  async update(dto: SyncPageUpdateDto, user: User) {
    const page = await this.target(dto.pageId, user);
    if (
      page.spaceId !== dto.expectedSpaceId ||
      page.workspaceId !== dto.expectedWorkspaceId
    ) {
      throw new ConflictException({
        code: 'CONFLICT',
        message: 'Page location changed since the binding was created',
      });
    }
    await this.pageAccessService.validateCanEdit(page, user);
    const prosemirrorJson = await parseSyncMarkdown(dto.content);
    let result: SyncEventResult;
    try {
      result = await this.collaborationGateway.handleYjsEvent(
        'syncPageContent',
        `page.${page.id}`,
        {
          pageId: page.id,
          spaceId: page.spaceId,
          workspaceId: page.workspaceId,
          user,
          prosemirrorJson,
          expectedRevision: dto.expectedRevision,
          expectedSpaceId: dto.expectedSpaceId,
          expectedWorkspaceId: dto.expectedWorkspaceId,
        },
      );
    } catch {
      throw new ServiceUnavailableException({
        code: 'UNCONFIRMED',
        message: 'The page update could not be confirmed',
      });
    }
    return this.result(page, result);
  }

  private result(page: Page, result?: SyncEventResult) {
    if (result?.status === 'conflict')
      throw new ConflictException({
        code: 'CONFLICT',
        message: 'Page changed since the observed revision',
      });
    if (
      result?.status !== 'ok' ||
      !/^[a-f0-9]{64}$/.test(result.revision) ||
      !/^[a-f0-9]{64}$/.test(result.persistedRevision)
    ) {
      throw new ServiceUnavailableException({
        code: 'UNCONFIRMED',
        message: 'Page persistence or live state could not be confirmed',
      });
    }
    return {
      pageId: page.id,
      spaceId: page.spaceId,
      workspaceId: page.workspaceId,
      revision: result.revision,
      persistedRevision: result.persistedRevision,
    };
  }
}
