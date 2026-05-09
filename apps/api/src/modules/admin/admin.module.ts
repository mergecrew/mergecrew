import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';

@Module({
  imports: [CommonModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
