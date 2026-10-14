import { validate } from 'class-validator';

function dtoClass(name: string) {
  let dto: any;
  try {
    dto = require('./sync-page.dto')[name];
  } catch (error: any) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
  }
  expect(typeof dto).toBe('function');
  return dto;
}
const pageId = '018e535d-6917-764f-a5fb-f8f275c88674';

describe('Sync DTO source and revision bounds', () => {
  it.each(['', ' \n', '中'.repeat(333334), null, {}])(
    'rejects invalid Markdown for replacement (%#)',
    async (content) => {
      const dto = Object.assign(new (dtoClass('SyncPageUpdateDto'))(), {
        pageId,
        content,
        expectedRevision: 'a'.repeat(64),
      });
      expect(
        (await validate(dto)).some((error) => error.property === 'content'),
      ).toBe(true);
    },
  );
  it('accepts an optional absent preview but rejects explicit null and malformed revisions', async () => {
    expect(
      await validate(
        Object.assign(new (dtoClass('SyncPageStateDto'))(), { pageId }),
      ),
    ).toEqual([]);
    expect(
      (
        await validate(
          Object.assign(new (dtoClass('SyncPageStateDto'))(), {
            pageId,
            content: null,
          }),
        )
      ).length,
    ).toBeGreaterThan(0);
    expect(
      (
        await validate(
          Object.assign(new (dtoClass('SyncPageUpdateDto'))(), {
            pageId,
            content: 'valid',
            expectedRevision: 'a'.repeat(63),
          }),
        )
      ).some((error) => error.property === 'expectedRevision'),
    ).toBe(true);
  });
  it('requires UUID space and workspace pins for every conditional replacement', async () => {
    const dto = Object.assign(new (dtoClass('SyncPageUpdateDto'))(), {
      pageId,
      content: 'saved',
      expectedRevision: 'a'.repeat(64),
    });
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'expectedSpaceId')).toBe(
      true,
    );
    expect(
      errors.some((error) => error.property === 'expectedWorkspaceId'),
    ).toBe(true);
  });
});
