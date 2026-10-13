import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { ForbiddenException } from '@nestjs/common';
import { AttachmentSearchService } from './attachment-search.service';
import { AttachmentSearchController } from './attachment-search.controller';

describe('community attachment search', () => {
  function setup() {
    const execute = jest.fn().mockResolvedValue({ rows: [] });
    const driver = new DummyDriver();
    jest.spyOn(driver, 'acquireConnection').mockResolvedValue({
      executeQuery: execute,
      async *streamQuery() {
        yield { rows: [] };
      },
    });
    const db = new Kysely<any>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => driver,
        createIntrospector: (database) => new PostgresIntrospector(database),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    });
    const spaceMembers = {
      getUserSpaceIdsQuery: (userId: string) =>
        db
          .selectFrom('spaceMembers')
          .select('spaceId')
          .where('userId', '=', userId),
    };
    const service = new AttachmentSearchService(db as any, spaceMembers as any);
    return { service, execute };
  }

  it('does not search for a blank keyword', async () => {
    const { service, execute } = setup();
    expect(
      await service.search({ query: ' ' } as any, {
        userId: 'user',
        workspaceId: 'workspace',
      }),
    ).toEqual({ items: [] });
    expect(execute).not.toHaveBeenCalled();
  });

  it('parameterizes keywords, applies live membership and inherited restrictions before pagination, and excludes deleted content', async () => {
    const { service, execute } = setup();
    await service.search(
      { query: "%_'; DROP TABLE pages; --", limit: 7, offset: 2 } as any,
      { userId: 'user', workspaceId: 'workspace' },
    );
    const compiled = execute.mock.calls[0][0] as {
      sql: string;
      parameters: readonly unknown[];
    };
    expect(compiled.sql).not.toContain('DROP TABLE');
    expect(compiled.parameters).toContain("%\\%\\_'; DROP TABLE pages; --%");
    expect(compiled.sql).toContain('with recursive');
    expect(compiled.sql).toContain('not exists');
    expect(compiled.sql).toContain('"pagePermissions"."id" is null');
    expect(compiled.sql).toContain('"groupUsers"');
    expect(compiled.sql).toContain('"pages"."deletedAt" is null');
    expect(compiled.sql).toContain('"attachments"."deletedAt" is null');
    expect(compiled.sql.indexOf('not exists')).toBeLessThan(
      compiled.sql.lastIndexOf('limit'),
    );
    expect(compiled.parameters).toEqual(
      expect.arrayContaining(['workspace', 'user', 7, 2, 'file']),
    );
  });

  it('uses the authenticated workspace and supports explicit space/creator filters', async () => {
    const { service, execute } = setup();
    await service.search(
      {
        query: 'guide',
        spaceId: 'space',
        creatorId: 'creator',
        limit: 3,
      } as any,
      { userId: 'user', workspaceId: 'workspace' },
    );
    const compiled = execute.mock.calls[0][0] as {
      sql: string;
      parameters: readonly unknown[];
    };
    expect(compiled.parameters).toEqual(
      expect.arrayContaining(['space', 'creator', 'workspace']),
    );
    expect(compiled.sql).not.toContain('"filePath"');
    expect(compiled.sql).not.toContain('select *');
  });

  it('rejects a forbidden space before executing the search', async () => {
    const service = { search: jest.fn() };
    const ability = {
      createForUser: jest.fn().mockResolvedValue({ cannot: () => true }),
    };
    const controller = new AttachmentSearchController(
      service as any,
      ability as any,
    );
    await expect(
      controller.search(
        { query: 'guide', spaceId: 'space' } as any,
        { id: 'user' } as any,
        { id: 'workspace' } as any,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.search).not.toHaveBeenCalled();
  });

  it('forwards only authenticated identity to the search service', async () => {
    const service = { search: jest.fn().mockResolvedValue({ items: [] }) };
    const controller = new AttachmentSearchController(
      service as any,
      {} as any,
    );
    await controller.search(
      { query: 'guide' } as any,
      { id: 'user' } as any,
      { id: 'workspace' } as any,
    );
    expect(service.search).toHaveBeenCalledWith(
      { query: 'guide' },
      { userId: 'user', workspaceId: 'workspace' },
    );
  });
});
