/**
 * UnifiedAI toolbar control (Grist Desktop only).
 *
 * A single top-bar button that shows the AI Assistant's active model (with its
 * author logo) and opens a dropdown to:
 *   - sign in when signed out, or sign out when signed in (state-based), and
 *   - pick the active model from the gateway catalog, each row showing the
 *     model_author icon.
 *
 * All state lives in the Electron main process; this talks to it over the
 * `window.unifiedAI` bridge (preload.ts) and refreshes live on `onChange`.
 */

import { menu, menuDivider, menuItem, menuItemStatic } from "app/client/ui2018/menus";
import { hoverTooltip } from "app/client/ui/tooltips";
import { icon } from "app/client/ui2018/icons";
import { testId, theme } from "app/client/ui2018/cssVars";
import type { UnifiedPickerModel, UnifiedStatus } from "app/client/electronAPI";

import { dom, DomContents, IDisposableOwner, Observable, styled } from "grainjs";

type UnifiedApi = NonNullable<Window["unifiedAI"]>;

export function buildUnifiedAIMenu(owner: IDisposableOwner): DomContents {
  const api = window.unifiedAI;
  if (!api) {
    return null; // not running under the Electron bridge
  }

  const status = Observable.create<UnifiedStatus | null>(owner, null);
  const models = Observable.create<UnifiedPickerModel[]>(owner, []);

  const refreshStatus = () => {
    api.status().then((s) => status.set(s)).catch(() => undefined);
  };
  refreshStatus();
  owner.autoDispose({ dispose: api.onChange(refreshStatus) });

  const loadModels = () => {
    api.models().then((list) => models.set(list)).catch(() => undefined);
  };

  return cssUnifiedBtn(
    dom.domComputed(status, (s) => {
      if (!s || !s.signedIn) {
        return [cssBtnIcon("Robot"), cssBtnLabel("Sign in to UnifiedAI")];
      }
      const m = s.model;
      return [
        m
          ? cssAuthorImg(dom.attr("src", m.icon), dom.attr("alt", m.author))
          : cssBtnIcon("Robot"),
        cssBtnLabel(m ? m.name : "AI model"),
        cssBtnCaret("Dropdown"),
      ];
    }),
    menu(
      () => {
        const s = status.get();
        if (!s || !s.signedIn) {
          return [
            menuItem(() => { void api.signIn(); }, "Sign in to UnifiedAI", testId("unified-signin")),
          ];
        }
        loadModels();
        return [
          cssMenuHeader("AI Assistant model"),
          dom.domComputed(models, (list) =>
            list.length === 0
              ? cssMenuHint("Loading models…")
              : list.map((m) => buildModelItem(api, m, s.modelId))
          ),
          menuDivider(),
          menuItem(() => { void api.signOut(); }, "Sign out of UnifiedAI", testId("unified-signout")),
        ];
      },
      { placement: "bottom-end" }
    ),
    hoverTooltip("UnifiedAI — AI Assistant model", { key: "topBarBtnTooltip" }),
    testId("unified-menu"),
  );
}

function buildModelItem(api: UnifiedApi, m: UnifiedPickerModel, activeId: string | null) {
  return menuItem(
    () => { void api.setModel(m.id); },
    cssModelRow(
      cssAuthorImg(dom.attr("src", m.icon), dom.attr("alt", m.author)),
      cssModelText(
        cssModelName(m.name),
        m.author ? cssModelAuthor(m.author) : null,
      ),
      m.id === activeId ? cssModelCheck(icon("Tick")) : null,
    ),
    testId("unified-model"),
  );
}

const cssUnifiedBtn = styled("div", `
  display: flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  margin: 4px 2px;
  padding: 0 8px;
  border-radius: 4px;
  cursor: pointer;
  color: ${theme.topBarButtonPrimaryFg};
  --icon-color: ${theme.topBarButtonPrimaryFg};
  white-space: nowrap;
  &:hover { opacity: 0.8; }
`);

const cssBtnIcon = styled(icon, `
  width: 18px;
  height: 18px;
  flex: none;
`);

const cssBtnCaret = styled(icon, `
  width: 14px;
  height: 14px;
  flex: none;
`);

const cssBtnLabel = styled("div", `
  font-size: 13px;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`);

const cssAuthorImg = styled("img", `
  width: 18px;
  height: 18px;
  flex: none;
  border-radius: 3px;
  object-fit: contain;
`);

const cssMenuHeader = styled(menuItemStatic, `
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.6;
  pointer-events: none;
`);

const cssMenuHint = styled(menuItemStatic, `
  opacity: 0.6;
  pointer-events: none;
`);

const cssModelRow = styled("div", `
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 220px;
`);

const cssModelText = styled("div", `
  display: flex;
  flex-direction: column;
  overflow: hidden;
`);

const cssModelName = styled("div", `
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`);

const cssModelAuthor = styled("div", `
  font-size: 11px;
  opacity: 0.6;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`);

const cssModelCheck = styled("div", `
  margin-left: auto;
  flex: none;
  --icon-color: ${theme.topBarButtonPrimaryFg};
`);
