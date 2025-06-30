import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { CouchDbConfig } from '@lectorium/api/configs';
import * as nano from 'nano';

@Injectable()
export class CouchDbService {
  private readonly logger = new Logger(CouchDbService.name);
  private readonly couchDbClient: nano.ServerScope;
  private readonly database: nano.DocumentScope<any>;

  constructor(
    @Inject(CouchDbConfig.KEY)
    config: ConfigType<typeof CouchDbConfig>,
  ) {
    const { username, password, host, port } = config;
    this.couchDbClient = nano(`http://${username}:${password}@${host}:${port}`);
  }

  /**
   * Creates a new collection (database) in CouchDB.
   * @param collection Name of the collection to create.
   * @returns Promise that resolves when the collection is created.
   * @throws Error if there is an error creating it.
   */
  async createCollection(collection: string): Promise<void> {
    try {
      await this.couchDbClient.db.create(collection);
    } catch (error) {
      if (error.statusCode === 412) {
        this.logger.warn(`Collection ${collection} already exists.`);
      } else {
        this.logger.error(`Error creating collection ${collection}:`, error);
        throw error;
      }
    }
  }

  /**
   * Sets security for a collection in CouchDB.
   * @param collection Collection name to set security for.
   * @param users Array of user names to grant access to the collection.
   * @returns Promise that resolves when the security is set.
   */
  async setCollectionSecurity(
    collection: string,
    users: string[],
  ): Promise<void> {
    await this.couchDbClient.request({
      method: 'PUT',
      path: `${collection}/_security`,
      body: {
        admins: {
          names: [],
          roles: [],
        },
        members: {
          names: users,
          roles: [],
        },
      },
    });
  }

  async getById<TEntity>(
    collection: string,
    id: string,
  ): Promise<TEntity | null> {
    try {
      this.couchDbClient.use(collection);
      const document = await this.database.get(id);
      return document as TEntity;
    } catch (error) {
      if (error.statusCode === 404) {
        this.logger.warn(`Document with ID ${id} not found.`);
        return null;
      }
      this.logger.error(`Error fetching document with ID ${id}:`, error);
      throw error;
    }
  }

  async find<TEntity>(
    collection: string,
    query: nano.MangoQuery,
  ): Promise<TEntity[]> {
    try {
      const database = this.couchDbClient.use(collection);
      const result = await database.find(query);
      return result.docs as TEntity[];
    } catch (error) {
      this.logger.error(
        `Error executing find query in collection ${collection}:`,
        error,
      );
      throw error;
    }
  }

  async insert<TEntity>(
    collection: string,
    document: TEntity,
  ): Promise<nano.DocumentInsertResponse> {
    try {
      const database = this.couchDbClient.use(collection);
      const response = await database.insert(document as any);
      return response;
    } catch (error) {
      this.logger.error(
        `Error inserting document into collection ${collection}:`,
        error,
      );
      throw error;
    }
  }
}
