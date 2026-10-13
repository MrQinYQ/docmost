import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { PublicSpaceModule } from '../public-space/public-space.module';
import { AttachmentSearchController } from './attachment-search.controller';
import { AttachmentSearchService } from './attachment-search.service';

@Module({
  imports: [PublicSpaceModule],
  controllers: [SearchController, AttachmentSearchController],
  providers: [SearchService, AttachmentSearchService],
  exports: [SearchService],
})
export class SearchModule {}
