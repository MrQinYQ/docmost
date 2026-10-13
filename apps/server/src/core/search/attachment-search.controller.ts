import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { OAuthScope } from '../../common/decorators/oauth-scope.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import SpaceAbilityFactory from '../casl/abilities/space-ability.factory';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../casl/interfaces/space-ability.type';
import { AttachmentSearchService } from './attachment-search.service';
import { AttachmentSearchDto } from './dto/attachment-search.dto';

@UseGuards(JwtAuthGuard)
@Controller('search-attachments')
export class AttachmentSearchController {
  constructor(
    private readonly service: AttachmentSearchService,
    private readonly spaceAbility: SpaceAbilityFactory,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @OAuthScope('read')
  async search(
    @Body() input: AttachmentSearchDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    if (input.spaceId) {
      const ability = await this.spaceAbility.createForUser(
        user,
        input.spaceId,
      );
      if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page))
        throw new ForbiddenException();
    }
    return this.service.search(input, {
      userId: user.id,
      workspaceId: workspace.id,
    });
  }
}
