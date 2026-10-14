import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { User } from '@docmost/db/types/entity.types';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { OAuthScope } from '../../common/decorators/oauth-scope.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { SyncPageStateDto, SyncPageUpdateDto } from './dto/sync-page.dto';
import { PageSyncService } from './services/page-sync.service';

@UseGuards(JwtAuthGuard)
@Controller('pages')
export class PageSyncController {
  constructor(private readonly pageSyncService: PageSyncService) {}

  @HttpCode(HttpStatus.OK)
  @Post('sync-state')
  @OAuthScope('read')
  state(@Body() dto: SyncPageStateDto, @AuthUser() user: User) {
    return this.pageSyncService.state(dto, user);
  }

  @HttpCode(HttpStatus.OK)
  @Post('sync-update')
  @OAuthScope('write')
  update(@Body() dto: SyncPageUpdateDto, @AuthUser() user: User) {
    return this.pageSyncService.update(dto, user);
  }
}
