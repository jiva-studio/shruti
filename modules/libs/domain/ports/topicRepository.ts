import type { TopicId } from "../core.js"
import type { Topic } from "../topic.js"

export interface ITopicRepository {
  getById(id: TopicId): Promise<Topic | null>
  listAll(): Promise<readonly Topic[]>
}
