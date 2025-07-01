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

  /**
   * Finds or creates new user by email.
   * @param name User name.
   * @returns User object if found, null otherwise.
   */
  async findOrCreateByName(name: string): Promise<User> {
    // Sanitize the name to create a valid CouchDB collection name
    const couchDbSafeName = 'users-' + name.replace(/[^a-zA-Z0-9_]/g, '-');

    // Create a new collection for the user's data if it doesn't exist
    // (will not throw an error if it already exists)
    await this.couchDbService.createCollection(couchDbSafeName);

    // Configure collection to be accessible only by the user
    // (will not throw an error if security is already set)
    await this.couchDbService.setCollectionSecurity(couchDbSafeName, [name]);

    // Create a new user document in the _users collection
    const existingUser = await this.findByName(name);
    if (existingUser) {
      return existingUser;
    }

    await this.couchDbService.insert('_users', {
      _id: 'org.couchdb.user:' + name,
      name: name,
      roles: ['user'],
      type: 'user',
    });

    return {
      name: name,
      roles: [],
    };
  }
}
