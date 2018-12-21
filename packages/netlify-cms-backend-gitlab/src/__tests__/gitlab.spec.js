jest.mock('netlify-cms-core/src/backend');
import { fromJS } from 'immutable';
import { partial } from 'lodash';
import { oneLine, stripIndent } from 'common-tags';
import nock from 'nock';
import { Cursor } from 'netlify-cms-lib-util';
import Gitlab from '../implementation';
import AuthenticationPage from '../AuthenticationPage';

const { Backend, LocalStorageAuthStore } = jest.requireActual('netlify-cms-core/src/backend');

const generateEntries = (path, length) => {
  const entries = Array.from({ length }, (val, idx) => {
    const count = idx + 1;
    const id = `00${count}`.slice(-3);
    const fileName = `test${id}.md`;
    return { id, fileName, filePath: `${path}/${fileName}` };
  });

  return {
    tree: entries.map(({ id, fileName, filePath }) => ({
      id: `d8345753a1d935fa47a26317a503e73e1192d${id}`,
      name: fileName,
      type: 'blob',
      path: filePath,
      mode: '100644',
    })),
    files: entries.reduce(
      (acc, { id, filePath }) => ({
        ...acc,
        [filePath]: stripIndent`
        ---
        title: test ${id}
        ---
        # test ${id}
      `,
      }),
      {},
    ),
  };
};

const manyEntries = generateEntries('many-entries', 500);

const mockRepo = {
  tree: {
    '/': [
      {
        id: '5d0620ebdbc92068a3e866866e928cc373f18429',
        name: 'content',
        type: 'tree',
        path: 'content',
        mode: '040000',
      },
    ],
    content: [
      {
        id: 'b1a200e48be54fde12b636f9563d659d44c206a5',
        name: 'test1.md',
        type: 'blob',
        path: 'content/test1.md',
        mode: '100644',
      },
      {
        id: 'd8345753a1d935fa47a26317a503e73e1192d623',
        name: 'test2.md',
        type: 'blob',
        path: 'content/test2.md',
        mode: '100644',
      },
    ],
    'many-entries': manyEntries.tree,
  },
  files: {
    'content/test1.md': stripIndent`
      ---
      title: test
      ---
      # test
    `,
    'content/test2.md': stripIndent`
      ---
      title: test2
      ---
      # test 2
    `,
    ...manyEntries.files,
  },
};

const resp = {
  user: {
    success: {
      id: 1,
    },
  },
  project: {
    success: {
      permissions: {
        project_access: {
          access_level: 30,
        },
      },
    },
    readOnly: {
      permissions: {
        project_access: {
          access_level: 10,
        },
      },
    },
  },
};

describe('gitlab backend', () => {
  let authStore;
  const repo = 'foo/bar';
  const defaultConfig = {
    backend: {
      name: 'gitlab',
      repo,
    },
  };
  const mockCredentials = { token: 'MOCK_TOKEN' };
  const expectedRepo = encodeURIComponent(repo);
  const expectedRepoUrl = `/projects/${expectedRepo}`;

  function resolveBackend(config = {}) {
    authStore = new LocalStorageAuthStore();
    return new Backend(
      {
        init: (...args) => new Gitlab(...args),
      },
      {
        backendName: 'gitlab',
        config: fromJS(config),
        authStore,
      },
    );
  }

  function mockApi(backend) {
    return nock(backend.implementation.api_root);
  }

  function interceptAuth(backend, { userResponse, projectResponse } = {}) {
    const api = mockApi(backend);
    api
      .get('/user')
      .query(true)
      .reply(200, userResponse || resp.user.success);

    api
      .get(expectedRepoUrl)
      .query(true)
      .reply(200, projectResponse || resp.project.success);
  }

  function parseQuery(uri) {
    const query = uri.split('?')[1];
    if (!query) {
      return {};
    }
    return query.split('&').reduce((acc, q) => {
      const [key, value] = q.split('=');
      acc[key] = value;
      return acc;
    }, {});
  }

  function createHeaders(backend, { basePath, path, page, perPage, pageCount, totalCount }) {
    const pageNum = parseInt(page, 10);
    const pageCountNum = parseInt(pageCount, 10);
    const url = `${backend.implementation.api_root}${basePath}`;
    const link = linkPage =>
      `<${url}?id=${expectedRepo}&page=${linkPage}&path=${path}&per_page=${perPage}&recursive=false>`;

    const linkHeader = oneLine`
      ${link(1)}; rel="first",
      ${link(pageCount)}; rel="last",
      ${pageNum === 1 ? '' : `${link(pageNum - 1)}; rel="prev",`}
      ${pageNum === pageCountNum ? '' : `${link(pageNum + 1)}; rel="next",`}
    `.slice(0, -1);

    return {
      'X-Page': page,
      'X-Total-Pages': pageCount,
      'X-Per-Page': perPage,
      'X-Total': totalCount,
      Link: linkHeader,
    };
  }

  function interceptCollection(backend, collection, { verb = 'get', page: expectedPage } = {}) {
    const api = mockApi(backend);
    const url = `${expectedRepoUrl}/repository/tree`;
    const { folder } = collection;
    const tree = mockRepo.tree[folder];
    api[verb](url)
      .query(({ path, page }) => {
        if (path !== folder) {
          return false;
        }
        if (expectedPage && parseInt(page, 10) !== parseInt(expectedPage, 10)) {
          return false;
        }
        return true;
      })
      .reply(uri => {
        const { page = 1, per_page = 20 } = parseQuery(uri);
        const pageCount = tree.length <= per_page ? 1 : Math.round(tree.length / per_page);
        const pageLastIndex = page * per_page;
        const pageFirstIndex = pageLastIndex - per_page;
        const resp = tree.slice(pageFirstIndex, pageLastIndex);
        return [
          200,
          verb === 'head' ? null : resp,
          createHeaders(backend, {
            basePath: url,
            path: folder,
            page,
            perPage: per_page,
            pageCount,
            totalCount: tree.length,
          }),
        ];
      });
  }

  function interceptFiles(backend, path) {
    const api = mockApi(backend);
    const url = `${expectedRepoUrl}/repository/files/${encodeURIComponent(path)}/raw`;
    api
      .get(url)
      .query(true)
      .reply(200, mockRepo.files[path]);
  }

  it('throws if configuration requires editorial workflow', () => {
    const resolveBackendWithWorkflow = partial(resolveBackend, {
      ...defaultConfig,
      publish_mode: 'editorial_workflow',
    });
    expect(resolveBackendWithWorkflow).toThrowErrorMatchingInlineSnapshot(
      `"The GitLab backend does not support the Editorial Workflow."`,
    );
  });

  it('throws if configuration does not include repo', () => {
    expect(resolveBackend).toThrowErrorMatchingInlineSnapshot(
      `"The GitLab backend needs a \\"repo\\" in the backend configuration."`,
    );
  });

  describe('authComponent', () => {
    it('returns authentication page component', () => {
      const backend = resolveBackend(defaultConfig);
      expect(backend.authComponent()).toEqual(AuthenticationPage);
    });
  });

  describe('authenticate', () => {
    it('throws if user does not have access to project', async () => {
      const backend = resolveBackend(defaultConfig);
      interceptAuth(backend, { projectResponse: resp.project.readOnly });
      await expect(
        backend.authenticate(mockCredentials),
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `"Your GitLab user account does not have access to this repo."`,
      );
    });

    it('stores and returns user object on success', async () => {
      const backendName = defaultConfig.backend.name;
      const backend = resolveBackend(defaultConfig);
      interceptAuth(backend);
      const user = await backend.authenticate(mockCredentials);
      expect(authStore.retrieve()).toEqual(user);
      expect(user).toEqual({ ...resp.user.success, ...mockCredentials, backendName });
    });
  });

  describe('currentUser', () => {
    it('returns null if no user', async () => {
      const backend = resolveBackend(defaultConfig);
      const user = await backend.currentUser();
      expect(user).toEqual(null);
    });

    it('returns the stored user if exists', async () => {
      const backendName = defaultConfig.backend.name;
      const backend = resolveBackend(defaultConfig);
      interceptAuth(backend);
      interceptAuth(backend);
      await backend.authenticate(mockCredentials);
      const user = await backend.currentUser();
      expect(user).toEqual({ ...resp.user.success, ...mockCredentials, backendName });
    });
  });

  describe('getToken', () => {
    it('returns the token for the current user', async () => {
      const backend = resolveBackend(defaultConfig);
      interceptAuth(backend);
      await backend.authenticate(mockCredentials);
      const token = await backend.getToken();
      expect(token).toEqual(mockCredentials.token);
    });
  });

  describe('logout', () => {
    it('sets token to null', async () => {
      const backend = resolveBackend(defaultConfig);
      interceptAuth(backend);
      await backend.authenticate(mockCredentials);
      await backend.logout();
      const token = await backend.getToken();
      expect(token).toEqual(null);
    });
  });

  describe('listEntries', () => {
    it('returns entries from folder collection', async () => {
      const collectionConfig = {
        name: 'foo',
        folder: 'content',
        fields: [{ name: 'title' }],
        // TODO: folder_based_collection is an internal string, we should not
        // be depending on it here
        type: 'folder_based_collection',
      };
      const backend = resolveBackend(defaultConfig);

      interceptAuth(backend);
      await backend.authenticate(mockCredentials);

      const tree = mockRepo.tree[collectionConfig.folder];
      tree.forEach(file => interceptFiles(backend, file.path));

      interceptCollection(backend, collectionConfig, { verb: 'head' });
      interceptCollection(backend, collectionConfig);
      const entries = await backend.listEntries(fromJS(collectionConfig));

      expect(entries).toEqual({
        cursor: expect.any(Cursor),
        entries: expect.arrayContaining(
          tree.map(file => expect.objectContaining({ path: file.path })),
        ),
      });
      expect(entries.entries).toHaveLength(2);
    });

    it('returns entries from file collection', async () => {
      const collectionConfig = {
        name: 'foo',
        files: [
          {
            label: 'foo',
            name: 'foo',
            file: 'content/test1.md',
            fields: [{ name: 'title' }],
          },
          {
            label: 'bar',
            name: 'bar',
            file: 'content/test2.md',
            fields: [{ name: 'title' }],
          },
        ],
        type: 'file_based_collection',
      };
      const { files } = collectionConfig;
      const backend = resolveBackend(defaultConfig);
      interceptAuth(backend);
      await backend.authenticate(mockCredentials);
      files.forEach(file => interceptFiles(backend, file.file));
      const entries = await backend.listEntries(fromJS(collectionConfig));
      expect(entries).toEqual({
        cursor: expect.any(Cursor),
        entries: expect.arrayContaining(
          files.map(file => expect.objectContaining({ path: file.file })),
        ),
      });
      expect(entries.entries).toHaveLength(2);
    });

    it('returns last page from paginated folder collection tree', async () => {
      const collectionConfig = {
        name: 'foo',
        folder: 'many-entries',
        fields: [{ name: 'title' }],
        // TODO: folder_based_collection is an internal string, we should not
        // be depending on it here
        type: 'folder_based_collection',
      };
      const tree = mockRepo.tree[collectionConfig.folder];
      const backend = resolveBackend(defaultConfig);
      interceptAuth(backend);
      await backend.authenticate(mockCredentials);

      const pageTree = tree.slice(-20);
      pageTree.forEach(file => interceptFiles(backend, file.path));
      interceptCollection(backend, collectionConfig, { verb: 'head' });
      interceptCollection(backend, collectionConfig, { page: 25 });
      const entries = await backend.listEntries(fromJS(collectionConfig));
      expect(entries.entries).toEqual(
        expect.arrayContaining(pageTree.map(file => expect.objectContaining({ path: file.path }))),
      );
      expect(entries.entries).toHaveLength(20);
    });
  });

  describe('traverseCursor', () => {
    const collectionConfig = {
      name: 'foo',
      folder: 'many-entries',
      fields: [{ name: 'title' }],
      // TODO: folder_based_collection is an internal string, we should not
      // be depending on it here
      type: 'folder_based_collection',
    };
    const tree = mockRepo.tree[collectionConfig.folder];
    let backend;

    beforeEach(async () => {
      backend = resolveBackend(defaultConfig);
      interceptAuth(backend);
      await backend.authenticate(mockCredentials);
      interceptCollection(backend, collectionConfig, { verb: 'head' });
    });

    it('returns complete last page of paginated tree', async () => {
      tree.slice(-20).forEach(file => interceptFiles(backend, file.path));
      interceptCollection(backend, collectionConfig, { page: 25 });
      const entries = await backend.listEntries(fromJS(collectionConfig));

      const nextPageTree = tree.slice(-40, -20);
      nextPageTree.forEach(file => interceptFiles(backend, file.path));
      interceptCollection(backend, collectionConfig, { page: 24 });
      const nextPage = await backend.traverseCursor(entries.cursor, 'next');
      expect(nextPage.entries).toEqual(
        expect.arrayContaining(
          nextPageTree.map(file => expect.objectContaining({ path: file.path })),
        ),
      );
      expect(nextPage.entries).toHaveLength(20);

      const prevPageTree = tree.slice(-20);
      interceptCollection(backend, collectionConfig, { page: 25 });
      const prevPage = await backend.traverseCursor(nextPage.cursor, 'prev');
      expect(prevPage.entries).toEqual(
        expect.arrayContaining(
          prevPageTree.map(file => expect.objectContaining({ path: file.path })),
        ),
      );
      expect(prevPage.entries).toHaveLength(20);
    });
  });

  afterEach(() => {
    nock.cleanAll();
    authStore.logout();
    expect(authStore.retrieve()).toEqual(null);
  });
});