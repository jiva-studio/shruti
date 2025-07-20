import { Injectable, Logger } from '@nestjs/common';
import { CouchDbService } from '@shruti/api/shared/services';

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
  async findById(userId: string): Promise<User | null> {
    return await this.couchDbService.getById<User>(
      '_users',
      'org.couchdb.user:' + userId,
    );
  }

  /**
   * Finds or creates new user by email.
   * @param userId User ID.
   * @returns User object if found, null otherwise.
   */
  async findOrCreateById(userId: string): Promise<User> {
    // Sanitize the name to create a valid CouchDB collection name
    const couchDbSafeName = 'users-' + userId;

    // Create a new collection for the user's data if it doesn't exist
    // (will not throw an error if it already exists)
    await this.couchDbService.createCollection(couchDbSafeName);

    // Configure collection to be accessible only by the user
    // (will not throw an error if security is already set)
    await this.couchDbService.setCollectionSecurity(couchDbSafeName, [userId]);

    // Create a new user document in the _users collection
    const existingUser = await this.findById(userId);
    if (existingUser) {
      return existingUser;
    }

    const userDoc = {
      _id: 'org.couchdb.user:' + userId,
      name: userId,
      roles: ['user'],
      type: 'user',
    };
    await this.couchDbService.insert('_users', userDoc);
    return userDoc;
  }

  /**
   * Deletes a user by their ID.
   * @param userId User Id.
   */
  async deleteById(userId: string): Promise<void> {
    const user = await this.findById(userId);
    if (!user) {
      this.logger.warn(`User ${userId} not found for deletion.`);
      return;
    }

    // Delete the user document from the _users collection
    await this.couchDbService.delete('_users', 'org.couchdb.user:' + userId);

    // Delete the user's data collection
    const couchDbSafeName = 'users-' + userId;
    await this.couchDbService.deleteCollection(couchDbSafeName);

    this.logger.log(`User ${userId} and their data have been deleted.`);
  }
}
