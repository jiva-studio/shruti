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
}
