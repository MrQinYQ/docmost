import { ForbiddenException } from '@nestjs/common';
import { PageAccessService } from '../page-access/page-access.service';

describe('Page sync authorization and transport result', () => {
  let service: any;
  let page: any;
  let result: any;
  let requests: any[];
  const user = { id: 'reader', workspaceId: 'workspace' } as any;
  const revision = 'a'.repeat(64);

  beforeEach(() => {
    let Service: any;
    try {
      Service = require('./page-sync.service').PageSyncService;
    } catch (error: any) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
    }
    expect(typeof Service).toBe('function');
    page = {
      id: '018e535d-6917-764f-a5fb-f8f275c88674',
      spaceId: 'space',
      workspaceId: 'workspace',
      deletedAt: null,
    };
    result = { status: 'ok', revision, persistedRevision: revision };
    requests = [];
    const access = new PageAccessService(
      {
        canUserAccessPage: async () => true,
        canUserEditPage: async () => ({
          hasAnyRestriction: false,
          canEdit: false,
        }),
      } as any,
      {
        createForUser: async () => ({
          cannot: (action: string) => action === 'edit',
        }),
      } as any,
      {} as any,
    );
    service = new Service({ findById: async () => page } as any, access, {
      handleYjsEvent: async (...args: any[]) => {
        requests.push(args);
        return result;
      },
    } as any);
  });

  it('allows a reader to inspect live state but denies replacement before dispatch', async () => {
    const state = await service.state({ pageId: page.id }, user);
    expect(state).toEqual({
      pageId: page.id,
      spaceId: 'space',
      workspaceId: 'workspace',
      revision,
      persistedRevision: revision,
    });
    await expect(
      service.update(
        {
          pageId: page.id,
          content: 'saved',
          expectedRevision: revision,
          expectedSpaceId: 'space',
          expectedWorkspaceId: 'workspace',
        },
        user,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(requests).toHaveLength(1);
  });

  it.each(['deleted', 'other workspace'])(
    'rejects a %s target without opening its document',
    async (kind) => {
      if (kind === 'deleted') page.deletedAt = new Date();
      else page.workspaceId = 'other';
      await expect(
        service.state({ pageId: page.id }, user),
      ).rejects.toMatchObject({ status: 404 });
      expect(requests).toEqual([]);
    },
  );

  it('maps owner conflict to HTTP409 and incomplete storage to HTTP503', async () => {
    result = { status: 'conflict', revision };
    await expect(
      service.state({ pageId: page.id }, user),
    ).rejects.toMatchObject({ status: 409, response: { code: 'CONFLICT' } });
    result = {
      status: 'unconfirmed',
      revision,
      persistedRevision: 'b'.repeat(64),
    };
    await expect(
      service.state({ pageId: page.id }, user),
    ).rejects.toMatchObject({ status: 503, response: { code: 'UNCONFIRMED' } });
  });
  it.each(['space', 'workspace'])(
    'rejects a stale expected %s pin before dispatching any body write',
    async (pin) => {
      const dto = {
        pageId: page.id,
        content: 'saved',
        expectedRevision: revision,
        expectedSpaceId: pin === 'space' ? 'old-space' : 'space',
        expectedWorkspaceId:
          pin === 'workspace' ? 'old-workspace' : 'workspace',
      };
      await expect(
        service.update(dto, { ...user, id: 'writer' }),
      ).rejects.toMatchObject({ status: 409, response: { code: 'CONFLICT' } });
      expect(requests).toEqual([]);
    },
  );
});
