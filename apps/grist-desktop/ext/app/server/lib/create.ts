import log from "app/server/lib/log";
import {getElectronLoginSystem} from "app/electron/LoginSystem";
import {
  BaseCreate,
  ICreate,
} from "app/server/lib/ICreate";
import { configureOpenAIAssistantV1 } from "app/server/lib/configureOpenAIAssistantV1";
import {DesktopDocStorageManager} from "app/server/lib/DesktopDocStorageManager";
import {HomeDBManager} from "app/gen-server/lib/homedb/HomeDBManager";
import { getDefaultUser } from "app/electron/userUtils";
import { HostedStorageManager } from "app/server/lib/HostedStorageManager";

const createDesktopStorageManager = async (...args: ConstructorParameters<typeof HostedStorageManager>) => {
  const storageManager = new DesktopDocStorageManager(...args);
  const homeDB: HomeDBManager = args[0].getHomeDBManager();
  // Remove any documents from the HomeDB that don't exist on disk. I.e. Sync home DB with filesystem state.
  // It would be better if this used some mechanism built into core,
  // but this is a passable workaround for the moment.
  await storageManager.loadFilePathsFromHomeDB(homeDB);
  const docsWithoutFiles = await storageManager.listDocsWithoutFilesInCache(homeDB);
  const user = await getDefaultUser(homeDB);
  // Can't do anything without a user (which shouldn't happen!), move on without synchronising.
  if (!user) {
    return storageManager;
  }
  const deletions = docsWithoutFiles.map((doc) =>
      homeDB.deleteDocument({
        userId: user.id,
        urlId: doc.id,
      })
      .catch((err) => {
        log.warn(`Failed to remove document ${doc.id} (${doc.name}) when synchronising DB and filesystem. ${err}`);
      })
  );
  // Not many sensible things we can do on failure, other than log.
  await Promise.allSettled(deletions);
  return storageManager;
};

class DesktopCreate extends BaseCreate {
  public constructor() {
    super('electron');
  }

  public override getLoginSystem() {
    return getElectronLoginSystem();
  }

  public override createHostedDocStorageManager(...args: ConstructorParameters<typeof HostedStorageManager>) {
    return createDesktopStorageManager(...args);
  }

  // Stock grist-desktop (DesktopCreate extends BaseCreate) leaves the AI
  // Assistant disabled — BaseCreate.Assistant() returns undefined and desktop
  // never overrides it, so getAssistant() is always undefined and the UI hides
  // the Assistant. Wire it up like CoreCreate does, so the ASSISTANT_* env our
  // UnifiedAI integration sets (pointing at the loopback gateway proxy) actually
  // enables the Formula + document Assistant.
  public override Assistant() {
    return configureOpenAIAssistantV1();
  }
}

export const create = new DesktopCreate();

export function getCreator(): ICreate {
  return create;
}
