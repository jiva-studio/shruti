import { Injectable, Logger } from '@nestjs/common';
import { CouchDbService } from '@lectorium/api/shared/services';

export type LoginField = 'email' | 'phone';
export type User = {
  name: string;
  roles: string[];
};

@Injectable()
export class AuthUsersService {
  private readonly logger = new Logger(AuthUsersService.name);

  /**
   * Creates an instance of AuthUsersService.
   */
  constructor(private readonly couchDbService: CouchDbService) {}

  /**
   * Finds a user by their email.
   * @param name User name.
   * @returns User object if found, null otherwise.
   */
  async findByName(name: string): Promise<User | null> {
    const documents = await this.couchDbService.find<User>('_users', {
      selector: { name },
      limit: 1,
    });
    if (documents.length === 1) {
      return documents[0];
    } else {
      return null;
    }
  }
}
