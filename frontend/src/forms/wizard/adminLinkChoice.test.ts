/**
 * The new-deployment wizard's Web2 admin group: where it starts, what stops
 * Continue and Deploy, what the create sends, what Test connection asks, what
 * the review says, and which rows of Advanced settings it takes over.
 *
 * Unit test, no browser. `pnpm test` in frontend/. The group itself is driven
 * in Chrome by `frontend/test/admin-link-browser.test.mjs`.
 *
 * The manager's stored token never reaches the page, so the create only says
 * to use it. Switched off, the deployment stores an empty ADMIN_API_URL, so its
 * uploader runs standalone whatever its version sets.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DeploymentSettingEntry, ManagerAdminLink, StackVersion } from '@streaming-infra-manager/common';

import type { NewDeploymentSettingsLoad } from '../../deployments/settings/useNewDeploymentSettings';
import { addressForKey } from '../validation';
import {
  adminLinkBody,
  adminLinkError,
  adminLinkSummary,
  adminLinkTestOf,
  asksAdminLink,
  chosenAdminLink,
  storedTokenElsewhere,
  withAdminLinkPointed,
} from './adminLinkChoice';
import { initialWizardState, type WizardContext, type WizardGoal, type WizardState } from './wizardState';

const ADMIN_URL = 'https://admin.example.com';
const TOKEN = 'synthetic-admin-token-0123456789abcdef';

function entry(overrides: Partial<DeploymentSettingEntry> & { key: string }): DeploymentSettingEntry {
  return {
    section: 'Admin mode', description: '', declared: true, secret: false, sampleValue: null, versionSet: true,
    versionValue: '', stored: false, storedValue: null, value: '', source: 'version', owner: null, field: null,
    services: ['stream-uploader'], running: 'not-running', engineSetting: null, ...overrides,
  };
}

const WITH_ADMIN = [
  entry({ key: 'LOG_LEVEL', section: 'Logging', versionValue: 'info', value: 'info' }),
  entry({ key: 'ADMIN_API_URL', field: { kind: 'url' } }),
  entry({ key: 'ADMIN_API_TOKEN', secret: true, versionValue: null, value: null, field: { kind: 'text', minLength: 32 } }),
];

function loaded(entries = WITH_ADMIN): NewDeploymentSettingsLoad {
  return { catalog: { versionId: 7, buildId: 'build-1', entries }, failure: null, reload: async () => undefined };
}

function contextWith(managerAdminLink: ManagerAdminLink | null, newDeploymentSettings: NewDeploymentSettingsLoad | undefined = loaded()): WizardContext {
  return {
    profiles: [],
    groups: [],
    serverHost: 'fixture.test',
    hostPassphrase: null,
    beeRpcEndpoint: { configured: false, host: null },
    poolResults: new Map(),
    versions: [{ id: 7, status: 'ready', isDefault: true, tested: true } as StackVersion],
    newDeploymentSettings,
    managerAdminLink,
  };
}

const DEFAULT: ManagerAdminLink = { url: ADMIN_URL, tokenStored: true, revision: 3 };
const ADDRESS_ONLY: ManagerAdminLink = { url: ADMIN_URL, tokenStored: false, revision: 3 };
const NONE: ManagerAdminLink = { url: null, tokenStored: false, revision: 0 };

function stateFor(goal: WizardGoal, over: Partial<WizardState> = {}): WizardState {
  return { ...initialWizardState({ goal }, contextWith(null)), name: 'stage', step: 3, ...over };
}

describe('which deployments the Web2 admin group asks about', () => {
  it('asks every goal that runs a stream uploader, and no other', () => {
    assert.equal(asksAdminLink(stateFor('stream')), true);
    assert.equal(asksAdminLink(stateFor('abr-uploader')), true);
    assert.equal(asksAdminLink(stateFor('custom', { components: ['srs', 'stream-uploader'] })), true);
    assert.equal(asksAdminLink(stateFor('custom', { components: ['srs', 'client'] })), false);
    assert.equal(asksAdminLink(stateFor('viewer')), false);
    assert.equal(asksAdminLink(stateFor('abr-pool')), false);
  });
});

describe('where the group starts', () => {
  it("starts on, at the manager's address and with its stored token, when the manager has a link", () => {
    assert.deepEqual(chosenAdminLink(stateFor('stream'), contextWith(DEFAULT)), { on: true, url: ADMIN_URL, tokenSource: 'stored', token: '' });
  });

  it('starts on with a token to type when the manager stores an address and no token', () => {
    assert.deepEqual(chosenAdminLink(stateFor('stream'), contextWith(ADDRESS_ONLY)), { on: true, url: ADMIN_URL, tokenSource: 'typed', token: '' });
  });

  it('starts off when the manager has no link, or its link could not be read', () => {
    assert.equal(chosenAdminLink(stateFor('stream'), contextWith(NONE)).on, false);
    assert.equal(chosenAdminLink(stateFor('stream'), contextWith(null)).on, false);
  });

  it("keeps the operator's own choice once they touched the group", () => {
    const own = { on: false, url: ADMIN_URL, tokenSource: 'stored' as const, token: '' };
    assert.deepEqual(chosenAdminLink(stateFor('stream', { adminLink: own }), contextWith(DEFAULT)), own);
  });
});

describe('what stops Continue and Deploy', () => {
  it('stops nothing for a link that is whole, or off', () => {
    assert.equal(adminLinkError(stateFor('stream'), contextWith(DEFAULT)), null);
    assert.equal(adminLinkError(stateFor('stream'), contextWith(NONE)), null);
  });

  it('waits for the settings list, which says whether the version takes a link at all', () => {
    const reading: NewDeploymentSettingsLoad = { catalog: null, failure: null, reload: async () => undefined };
    assert.equal(adminLinkError(stateFor('stream'), contextWith(DEFAULT, reading)), "Web2 admin: reading this version's settings");
  });

  it('asks for an address the uploader can use, and a token', () => {
    const on = { on: true, url: '', tokenSource: 'typed' as const, token: TOKEN };
    assert.equal(adminLinkError(stateFor('stream', { adminLink: on }), contextWith(NONE)), 'Web2 admin: type the address, or switch the link off');
    assert.equal(
      adminLinkError(stateFor('stream', { adminLink: { ...on, url: 'admin.example.com' } }), contextWith(NONE)),
      'Web2 admin: ADMIN_API_URL must be an http or https address, such as https://admin.example.com.',
    );
    assert.equal(
      adminLinkError(stateFor('stream', { adminLink: { ...on, url: ADMIN_URL, token: 'short' } }), contextWith(NONE)),
      'Web2 admin: ADMIN_API_TOKEN must be at least 32 characters.',
    );
    assert.equal(
      adminLinkError(stateFor('stream', { adminLink: { ...on, url: ADMIN_URL, token: '' } }), contextWith(NONE)),
      "Web2 admin: type the token, or use the manager's stored one",
    );
    assert.equal(
      adminLinkError(stateFor('stream', { adminLink: { ...on, url: ADMIN_URL, tokenSource: 'stored' } }), contextWith(ADDRESS_ONLY)),
      'Web2 admin: the manager stores no token, so type one here',
    );
  });

  it("asks for a typed token when the address leaves the origin the manager's token was saved for", () => {
    const moved = { on: true, url: 'https://admin2.example.com', tokenSource: 'stored' as const, token: '' };
    assert.equal(
      adminLinkError(stateFor('stream', { adminLink: moved }), contextWith(DEFAULT)),
      "Web2 admin: the manager's stored token was saved for another address, so type the token for this one",
    );
    assert.equal(storedTokenElsewhere(stateFor('stream', { adminLink: moved }), contextWith(DEFAULT)), true);
    assert.equal(adminLinkTestOf(stateFor('stream', { adminLink: moved }), contextWith(DEFAULT)), null);
    assert.equal(adminLinkError(stateFor('stream', { adminLink: { ...moved, url: `${ADMIN_URL}/v2` } }), contextWith(DEFAULT)), null);
    assert.equal(storedTokenElsewhere(stateFor('stream', { adminLink: { ...moved, url: `${ADMIN_URL}/v2` } }), contextWith(DEFAULT)), false);
    assert.equal(adminLinkError(stateFor('stream', { adminLink: { ...moved, tokenSource: 'typed', token: TOKEN } }), contextWith(DEFAULT)), null);
  });
});

describe('what the create sends', () => {
  it("sends the address and asks for the manager's stored token, which it never holds", () => {
    assert.deepEqual(adminLinkBody(stateFor('stream'), contextWith(DEFAULT)), {
      settings: [{ key: 'ADMIN_API_URL', value: ADMIN_URL }],
      useManagerToken: true,
    });
  });

  it('sends a token typed here beside the address', () => {
    const typed = { on: true, url: ADMIN_URL, tokenSource: 'typed' as const, token: TOKEN };
    assert.deepEqual(adminLinkBody(stateFor('stream', { adminLink: typed }), contextWith(DEFAULT)), {
      settings: [{ key: 'ADMIN_API_URL', value: ADMIN_URL }, { key: 'ADMIN_API_TOKEN', value: TOKEN }],
      useManagerToken: false,
    });
  });

  it('sends an empty address when switched off, so the uploader runs standalone whatever the version sets', () => {
    assert.deepEqual(adminLinkBody(stateFor('stream'), contextWith(NONE)), { settings: [{ key: 'ADMIN_API_URL', value: '' }], useManagerToken: false });
  });

  it('sends nothing for a goal that runs no uploader, or a version that takes no link', () => {
    const nothing = { settings: [], useManagerToken: false };
    assert.deepEqual(adminLinkBody(stateFor('viewer'), contextWith(DEFAULT)), nothing);
    assert.deepEqual(adminLinkBody(stateFor('stream'), contextWith(DEFAULT, loaded(WITH_ADMIN.slice(0, 1)))), nothing);
  });
});

describe('what Test connection asks from the group', () => {
  it("tests the address with the manager's stored token, and the stream key's address as the owner to compare", () => {
    const state = stateFor('stream');
    assert.deepEqual(adminLinkTestOf(state, contextWith(DEFAULT)), {
      url: ADMIN_URL,
      token: { source: 'stored' },
      feedOwner: addressForKey(state.generatedKey),
    });
  });

  it('tests a typed token, and nothing until the address and the token are usable', () => {
    const typed = { on: true, url: ADMIN_URL, tokenSource: 'typed' as const, token: TOKEN };
    assert.deepEqual(adminLinkTestOf(stateFor('stream', { adminLink: typed }), contextWith(NONE))?.token, { source: 'typed', value: TOKEN });
    assert.equal(adminLinkTestOf(stateFor('stream', { adminLink: { ...typed, token: 'short' } }), contextWith(NONE)), null);
    assert.equal(adminLinkTestOf(stateFor('stream', { adminLink: { ...typed, url: '' } }), contextWith(NONE)), null);
    assert.equal(adminLinkTestOf(stateFor('stream'), contextWith(NONE)), null);
  });
});

describe('what the review says', () => {
  it('names the address and where the token comes from, never the token', () => {
    assert.equal(adminLinkSummary(stateFor('stream'), contextWith(DEFAULT)), `Linked to ${ADMIN_URL}, with the manager's stored token.`);
    const typed = { on: true, url: ADMIN_URL, tokenSource: 'typed' as const, token: TOKEN };
    assert.equal(adminLinkSummary(stateFor('stream', { adminLink: typed }), contextWith(DEFAULT)), `Linked to ${ADMIN_URL}, with a token typed here.`);
    assert.equal(adminLinkSummary(stateFor('stream'), contextWith(NONE)), 'Not linked. The uploader runs standalone.');
    assert.equal(adminLinkSummary(stateFor('viewer'), contextWith(DEFAULT)), null);
  });
});

describe('the rows of Advanced settings the group takes over', () => {
  it('points the two keys at the group for a deployment that runs an uploader, and leaves every other key alone', () => {
    const pointed = withAdminLinkPointed(WITH_ADMIN, stateFor('stream'));
    assert.deepEqual(pointed.map(({ key, owner }) => [key, owner]), [['LOG_LEVEL', null], ['ADMIN_API_URL', 'admin-link'], ['ADMIN_API_TOKEN', 'admin-link']]);
  });

  it('leaves them to the list for a deployment that runs no uploader', () => {
    assert.deepEqual(withAdminLinkPointed(WITH_ADMIN, stateFor('viewer')), WITH_ADMIN);
  });

  it('leaves them to the list for a version that declares only one of them, which the group cannot set', () => {
    const tokenOnly = WITH_ADMIN.filter(({ key }) => key !== 'ADMIN_API_URL');
    assert.deepEqual(withAdminLinkPointed(tokenOnly, stateFor('stream')), tokenOnly);
  });
});
