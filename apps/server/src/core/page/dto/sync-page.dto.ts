import { IsUUID, Matches, ValidateBy, ValidateIf } from 'class-validator';
import { isSyncMarkdown } from '../../../collaboration/sync-revision.util';

function MarkdownContent() {
  return ValidateBy({
    name: 'syncMarkdown',
    validator: {
      validate: isSyncMarkdown,
      defaultMessage: () =>
        'content must be nonblank Markdown of at most 1000000 UTF-8 bytes',
    },
  });
}

export class SyncPageStateDto {
  @IsUUID()
  pageId: string;

  @ValidateIf((value) => value.content !== undefined)
  @MarkdownContent()
  content?: string;
}

export class SyncPageUpdateDto {
  @IsUUID()
  pageId: string;

  @MarkdownContent()
  content: string;

  @Matches(/^[a-f0-9]{64}$/)
  expectedRevision: string;

  @IsUUID()
  expectedSpaceId: string;

  @IsUUID()
  expectedWorkspaceId: string;
}
