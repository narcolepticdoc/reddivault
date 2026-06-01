// search.js — part of RedditVault (auto-split from the original single-file PWA).
import { state } from './state.js';

export function validateTagName(name) {
  return /^[a-zA-Z0-9 &\/]+$/.test(name.trim());
}

// Serialise active tag chips + text search into a saveable query string
// ─── LIST OPTIONS (filters + sort saved per list) ────────────────────────────
// These are display-layer settings stored alongside but separate from the query.
// They apply when a list is opened directly; they are NEVER consulted during
// tag chip matching so compound searches always behave predictably.
export function serialiseListOptions() {
  return JSON.stringify({
    filterType:    state.filterType    !== 'all' ? state.filterType    : undefined,
    filterRating:  state.filterRating  > 0       ? state.filterRating  : undefined,
    filterFavourite: state.filterFavourite        ? true               : undefined,
    filterHasLinks:  state.filterHasLinks         ? true               : undefined,
    filterDateField: state.filterDateField !== 'postCreatedAt' ? state.filterDateField : undefined,
    filterDateFrom:  state.filterDateFrom  || undefined,
    filterDateTo:    state.filterDateTo    || undefined,
    filterSubreddit: state.filterSubreddit.trim() || undefined,
    filterAuthor:    state.filterAuthor.trim()    || undefined,
    sortBy:          state.sortBy  !== 'postCreatedAt' ? state.sortBy  : undefined,
    sortDir:         state.sortDir !== 'desc'          ? state.sortDir : undefined,
    searchBody:      state.searchBody               ? true               : undefined,
  });
}

export function applyListOptions(optionsJson) {
  // Restore state from saved options; fall back to defaults for anything not stored.
  let opts = {};
  try { if (optionsJson) opts = JSON.parse(optionsJson); } catch(e) {}
  state.filterType      = opts.filterType      || 'all';
  state.filterRating    = opts.filterRating    || 0;
  state.filterFavourite = opts.filterFavourite || false;
  state.filterHasLinks  = opts.filterHasLinks  || false;
  state.filterDateField = opts.filterDateField || 'postCreatedAt';
  state.filterDateFrom  = opts.filterDateFrom  || '';
  state.filterDateTo    = opts.filterDateTo    || '';
  state.filterSubreddit = opts.filterSubreddit || '';
  state.filterAuthor    = opts.filterAuthor    || '';
  state.sortBy          = opts.sortBy          || 'postCreatedAt';
  state.sortDir         = opts.sortDir         || 'desc';
  state.searchBody      = opts.searchBody      || false;
}

export function optionsSummaryParts(optionsJson) {
  // Returns an array of short human-readable strings describing saved options.
  // Used in list cards, list detail view, and edit modal.
  let opts = {};
  try { if (optionsJson) opts = JSON.parse(optionsJson); } catch(e) {}
  const parts = [];
  if (opts.filterType && opts.filterType !== 'all')
    parts.push(opts.filterType === 'post' ? '📝 Posts only' : '💬 Comments only');
  if (opts.filterRating)      parts.push(`★${opts.filterRating}+`);
  if (opts.filterFavourite)   parts.push('⭐ Faves');
  if (opts.filterHasLinks)    parts.push('🔗 Has links');
  if (opts.searchBody)        parts.push('📄 Body search');
  if (opts.filterSubreddit)   parts.push(`r/${opts.filterSubreddit}`);
  if (opts.filterAuthor)      parts.push(`u/${opts.filterAuthor}`);
  if (opts.filterDateFrom || opts.filterDateTo) parts.push('📅 Date range');
  const sortLabels = { savedAt: 'Date saved', title: 'Title', subreddit: 'Subreddit', affinity: 'Affinity', rating: 'Rating' };
  if (opts.sortBy && opts.sortBy !== 'postCreatedAt')
    parts.push(`Sort: ${sortLabels[opts.sortBy] || opts.sortBy}${opts.sortDir === 'asc' ? ' ↑' : ''}`);
  else if (opts.sortDir === 'asc')
    parts.push('Sort: Post date ↑');
  return parts;
}

export function hasNonDefaultOptions() {
  return state.filterType !== 'all' || state.filterRating > 0 ||
    state.filterFavourite || state.filterHasLinks ||
    state.filterDateFrom || state.filterDateTo ||
    state.filterSubreddit.trim() || state.filterAuthor.trim() ||
    state.sortBy !== 'postCreatedAt' || state.sortDir !== 'desc' ||
    state.searchBody;
}

export function serialiseQueryWithTags(textQuery, tagIds, tagMode) {
  const tagTokens = tagIds.map(id => {
    const list = state.lists.find(l => l.id === id);
    if (!list) return null;
    const name = list.tagName || list.name;
    return `[#${name}]`;
  }).filter(Boolean);

  if (tagTokens.length === 0) return textQuery;

  let tagPart;
  if (tagTokens.length === 1) {
    tagPart = tagTokens[0];
  } else if (tagMode === 'OR') {
    tagPart = `(${tagTokens.join(', ')})`;
  } else {
    tagPart = tagTokens.join(' ');
  }

  return textQuery ? `${tagPart} ${textQuery}` : tagPart;
}

// Extract [#name] tokens from a query string, returning { tags: ['name',...], remainder: str }
export function extractTagTokens(query) {
  const tags = [];
  const remainder = query.replace(/\[#([^\]]+)\]/g, (_, name) => {
    tags.push(name.trim());
    return '';
  }).replace(/\s+/g, ' ').trim();
  return { tags, remainder };
}

// Build a cycle-detection graph: Map<listId, Set<listId>> of direct tag dependencies
export function buildTagDepGraph() {
  const graph = new Map();
  for (const list of state.lists) {
    if (list.type !== 'smart') continue;
    const { tags } = extractTagTokens(list.query || '');
    const deps = new Set();
    for (const tagName of tags) {
      const dep = state.lists.find(l => l.isTag && l.type === 'smart' && (l.tagName || l.name) === tagName);
      if (dep) deps.add(dep.id);
    }
    graph.set(list.id, deps);
  }
  return graph;
}

// Find cycle path if adding depId as dependency of listId would create one.
// Returns array of names forming the cycle, or null if no cycle.
export function findCyclePath(listId, newDepId, graph) {
  // Temporarily add the new dependency
  const tempGraph = new Map(graph);
  const existing = new Set(tempGraph.get(listId) || []);
  existing.add(newDepId);
  tempGraph.set(listId, existing);

  // DFS from newDepId — if we can reach listId, there's a cycle
  const path = [];
  const visited = new Set();
  const getName = id => {
    const l = state.lists.find(l => l.id === id);
    return l ? `#${l.tagName || l.name}` : `#${id}`;
  };

  function dfs(current) {
    if (current === listId) return true;
    if (visited.has(current)) return false;
    visited.add(current);
    path.push(current);
    for (const next of (tempGraph.get(current) || [])) {
      if (dfs(next)) return true;
    }
    path.pop();
    return false;
  }

  if (dfs(newDepId)) {
    const cycleIds = [listId, ...path, listId];
    return cycleIds.map(getName);
  }
  return null;
}

// Get all tag IDs that (directly or transitively) depend on listId —
// these cannot reference listId without creating a cycle
export function getTagsContaining(listId, graph) {
  const result = new Set();
  for (const [id, deps] of graph) {
    if (id === listId) continue;
    // DFS from id — if it reaches listId, id depends on listId
    const visited = new Set();
    function reaches(current) {
      if (current === listId) return true;
      if (visited.has(current)) return false;
      visited.add(current);
      for (const next of (graph.get(current) || [])) {
        if (reaches(next)) return true;
      }
      return false;
    }
    if (reaches(id)) result.add(id);
  }
  return result;
}

// Memoise parseSearchQuery for repeated calls with the same input (e.g. filteredItems)
export let _parsedQueryCache = { raw: null, tokens: [] };
export function cachedParseSearch(raw) {
  if (raw === _parsedQueryCache.raw) return _parsedQueryCache.tokens;
  const tokens = parseSearchQuery(raw);
  _parsedQueryCache = { raw, tokens };
  return tokens;
}

export function parseSearchQuery(raw) {
  const tokens = [];
  // Normalise curly/smart quotes to straight quotes (iOS autocorrect)
  // Also lowercase field prefixes (R/, U/, R:, U:, TYPE:) so they match case-insensitively
  let str = raw.trim()
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"')
    .replace(/\b(R|U|TYPE)([:\/])/g, (_, p, sep) => p.toLowerCase() + sep);

  // Extract [#tag name] tokens first — before any other parsing
  str = str.replace(/\[#([^\]]+)\]/g, (_, name) => {
    tokens.push({ type: 'tagRef', name: name.trim() });
    return '';
  }).trim();

  // Check if the entire query (ignoring negation/field tokens) is comma-separated —
  // if so, treat the whole thing as a single OR group
  // A "bare comma query" is one that contains commas but no parens, quotes, or field prefixes
  const hasParens  = /\(/.test(str);
  const hasQuotes  = /"/.test(str);
  const hasField   = /\b(r|u|type)[:\/]/.test(str);
  const hasCommas  = /,/.test(str);

  if (hasCommas && !hasParens) {
    // Treat entire query as OR group.
    // Each comma-separated part may be a bare word, a quoted phrase, or a wildcard.
    // Parts with a leading - are negated; if any are negated fall through to AND parsing.
    const parts = str.split(',').map(s => s.trim()).filter(Boolean);
    const anyNegated = parts.some(p => p.startsWith('-'));
    // Only use comma-OR path when every part is a single token (no spaces except inside quotes)
    const partRe2 = /^(-?)(?:(r|u|type)[:\/]\S+|"[^"]+"|\S+)$/;
    const allSingleTokens = parts.every(p => partRe2.test(p));
    if (parts.length && !anyNegated && allSingleTokens) {
      const orTokens = [];
      const partRe = /^(-?)(?:(r|u|type)[:\/](\S+)|"([^"]+)"|(\S+))$/;
      for (const part of parts) {
        const pm = part.match(partRe);
        if (!pm) continue;
        if (pm[2]) {
          // Field token inside comma list — emit as regular field token, collapse later
          const fieldMap = { r: 'subreddit', u: 'author', type: 'type' };
          const _fv = pm[3].toLowerCase();
          tokens.push({ type: pm[2] === 'type' ? 'typeFilter' : 'field',
            field: fieldMap[pm[2]], value: _fv.replace(/\*+$/, ''), prefixWild: _fv.endsWith('*'), negate: pm[1] === '-' });
        } else if (pm[4]) {
          // Quoted phrase
          orTokens.push({ exact: true, value: pm[4].toLowerCase() });
        } else if (pm[5]) {
          const parsed = _parseWildcard(pm[5].toLowerCase());
          if (parsed.value) orTokens.push(parsed);
        }
      }
      if (orTokens.length) {
        tokens.push({ type: 'orGroup', values: orTokens, negate: false });
      }
      // Fall through to collapse step below — it will merge multiple field tokens
      // of the same type into a fieldOrGroup.
      if (tokens.length) {
        // Skip the paren/remainder parsing — go straight to collapse and return
        const fieldTypes2 = ['subreddit', 'author'];
        for (const field of fieldTypes2) {
          const ft = tokens.filter(t => t.type === 'field' && t.field === field && !t.negate);
          if (ft.length > 1) {
            const idx = tokens.indexOf(ft[0]);
            tokens.splice(0, tokens.length, ...tokens.filter(t => !(t.type === 'field' && t.field === field && !t.negate)));
            tokens.splice(idx, 0, { type: 'fieldOrGroup', field, values: ft.map(t => t.value), prefixWilds: ft.map(t => !!t.prefixWild) });
          }
        }
        return tokens;
      }
    }
  }

  // Extract explicit OR groups: (a, b, c) or ([#tag], [#tag2], "phrase", word)
  str = str.replace(/\(([^)]+)\)/g, (_, inner) => {
    // Split by comma, each part may be a [#tag] token, a quoted phrase, or a plain term
    const parts = inner.split(',').map(s => s.trim()).filter(Boolean);
    const orTokens = [];
    for (const part of parts) {
      const tagMatch = part.match(/^\[#([^\]]+)\]$/);
      if (tagMatch) {
        orTokens.push({ isTagRef: true, name: tagMatch[1].trim() });
        continue;
      }
      const quoteMatch = part.match(/^"([^"]+)"$/);
      if (quoteMatch) {
        orTokens.push({ exact: true, value: quoteMatch[1].toLowerCase() });
        continue;
      }
      const parsed = _parseWildcard(part.toLowerCase());
      if (parsed.value) orTokens.push(parsed);
    }
    if (orTokens.length) tokens.push({ type: 'orGroup', values: orTokens, negate: false });
    return '';
  });

  // Parse remainder: field prefixes, quoted strings, bare words, negation
  const re = /(-?)(?:(r|u|type)[:\/](\S+)|"([^"]+)"|(\S+))/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    const negate = m[1] === '-';
    if (m[2] === 'r')    { const _rv = m[3].toLowerCase().replace(/,+$/, ''); tokens.push({ type: 'field', field: 'subreddit', value: _rv.replace(/\*+$/, ''), prefixWild: _rv.endsWith('*'), negate }); continue; }
    if (m[2] === 'u')    { const _uv = m[3].toLowerCase().replace(/,+$/, ''); tokens.push({ type: 'field', field: 'author',    value: _uv.replace(/\*+$/, ''), prefixWild: _uv.endsWith('*'), negate }); continue; }
    if (m[2] === 'type') { tokens.push({ type: 'typeFilter', value: m[3].toLowerCase().replace(/,+$/, ''), negate }); continue; }
    if (m[4]) {
      // Quoted phrase — exact substring, no word boundary
      tokens.push({ type: 'text', value: m[4].toLowerCase(), negate, exact: true });
    } else if (m[5]) {
      const parsed = _parseWildcard(m[5].toLowerCase());
      if (!parsed.value) continue;
      tokens.push({ type: 'text', negate, ...parsed });
    }
  }
  // Collapse multiple field tokens of the same field into a single orGroup.
  // e.g. r/python + r/rust → orGroup[subreddit:python, subreddit:rust]
  // This makes r/this r/that and r/this, r/that both behave as OR on that field.
  const fieldTypes = ['subreddit', 'author'];
  for (const field of fieldTypes) {
    const fieldTokens = tokens.filter(t => t.type === 'field' && t.field === field && !t.negate);
    if (fieldTokens.length > 1) {
      // Remove individual tokens and replace with one orGroup
      const idx = tokens.indexOf(fieldTokens[0]);
      tokens.splice(0, tokens.length,
        ...tokens.filter(t => !(t.type === 'field' && t.field === field && !t.negate))
      );
      tokens.splice(idx, 0, {
        type: 'fieldOrGroup',
        field,
        values: fieldTokens.map(t => t.value),
        prefixWilds: fieldTokens.map(t => !!t.prefixWild),
      });
    }
  }
  return tokens;
}

// Parse wildcard flags from a raw term string into a token-like object
export function _parseWildcard(raw) {
  const leadWild  = raw.startsWith('*');
  const trailWild = raw.endsWith('*');
  const term = raw.replace(/^\*+|\*+$/g, '');
  return {
    value: term,
    exact:       leadWild && trailWild,
    suffixWild:  leadWild && !trailWild,
    prefixWild:  !leadWild && trailWild,
  };
}

// Word-boundary test: does `haystack` contain `needle` as a whole word?
export function _wordMatch(haystack, needle) {
  const wordChar = /\w/;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    const before = idx === 0 ? '' : haystack[idx - 1];
    const after  = idx + needle.length >= haystack.length ? '' : haystack[idx + needle.length];
    if ((!before || !wordChar.test(before)) && (!after || !wordChar.test(after))) return true;
    idx++;
  }
  return false;
}

export function _textMatch(haystack, token) {
  const h = haystack.toLowerCase();
  const v = token.value;
  if (token.exact) return h.includes(v);  // "phrase" or *word* — substring in full text

  if (token.suffixWild || token.prefixWild) {
    // Apply to each word in the haystack individually
    const words = h.split(/\W+/).filter(Boolean);
    if (token.suffixWild) return words.some(w => w.endsWith(v));   // *word
    if (token.prefixWild) return words.some(w => w.startsWith(v)); // word*
  }
  return _wordMatch(h, v); // default: whole word
}

export function itemMatchesText(item, value, token) {
  // When called from orGroup (value only, no token), do whole-word match
  const tok = token || { value };
  // Always search title. Subreddit and author are excluded from plain-text
  // search — use r: and u: syntax to target those fields explicitly.
  // Body text is opt-in via the searchBody toggle.
  if (_textMatch(item.title || '', tok)) return true;
  if (state.searchBody && _textMatch(item.body || '', tok)) return true;
  return false;
}

export function itemMatchesTokens(item, tokens, _visited) {
  const visited = _visited || new Set();
  for (const t of tokens) {
    let match = false;
    if (t.type === 'tagRef') {
      // Resolve tag by name at match time
      const tag = state.lists.find(l => l.isTag && l.type === 'smart' && (l.tagName || l.name) === t.name);
      if (!tag) {
        match = true; // missing tag → ignore (no-op)
      } else if (visited.has(tag.id)) {
        match = true; // cycle guard — ignore
      } else {
        const newVisited = new Set(visited);
        newVisited.add(tag.id);
        const tagTokens = parseSearchQuery(tag.query || '');
        match = tagTokens.length === 0 || itemMatchesTokens(item, tagTokens, newVisited);
      }
    } else if (t.type === 'orGroup') {
      match = t.values.some(tok => {
        if (tok.isTagRef) {
          const tag = state.lists.find(l => l.isTag && l.type === 'smart' && (l.tagName || l.name) === tok.name);
          if (!tag || visited.has(tag.id)) return true;
          const newVisited = new Set(visited);
          newVisited.add(tag.id);
          const tagTokens = parseSearchQuery(tag.query || '');
          return tagTokens.length === 0 || itemMatchesTokens(item, tagTokens, newVisited);
        }
        return itemMatchesText(item, tok.value, tok);
      });
    } else if (t.type === 'field') {
      const fieldVal = (item[t.field] || '').toLowerCase();
      match = t.prefixWild ? fieldVal.startsWith(t.value) : fieldVal === t.value;
    } else if (t.type === 'fieldOrGroup') {
      const fieldVal = (item[t.field] || '').toLowerCase();
      match = t.values.some((v, i) => t.prefixWilds?.[i] ? fieldVal.startsWith(v) : fieldVal === v);
    } else if (t.type === 'typeFilter') {
      match = item.type === t.value;
    } else {
      match = itemMatchesText(item, t.value, t);
    }
    if (t.negate && match)   return false;
    if (!t.negate && !match) return false;
  }
  return true;
}

// ─── AFFINITY SCORE ──────────────────────────────────────────────────────────
// Scores items on personal curation signals:
//   rating    → 0–50 pts (unrated = 10 neutral baseline so unrated items stay discoverable)
//   favourite → 30 pts flat bonus
//   author    → 0–15 pts, log-scaled from authorFreq so no single author dominates
export function affinityScore(item) {
  const ratingPts = item.rating ? (item.rating / 5) * 50 : 10;
  const favPts = item.isFavourite ? 30 : 0;
  const freq = item.author ? (state.authorFreq[item.author] || 0) : 0;
  const maxFreq = state.maxAuthorFreq || 1;
  const authorPts = (Math.log(freq + 1) / Math.log(maxFreq + 1)) * 15;
  return ratingPts + favPts + authorPts;
}

export function sortItems(items, applyAuthorBoost = false) {
  const dir = state.sortDir === 'asc' ? 1 : -1;

  // Precompute timestamps / scores to avoid repeated object creation inside sort comparisons
  let _sortKey;
  if (state.sortBy === 'postCreatedAt' || state.sortBy === 'savedAt') {
    const field = state.sortBy;
    _sortKey = new Map();
    for (const item of items) _sortKey.set(item, new Date(item[field] || 0).getTime());
  } else if (state.sortBy === 'affinity') {
    _sortKey = new Map();
    for (const item of items) _sortKey.set(item, affinityScore(item));
  }

  const sorted = [...items].sort((a, b) => {
    switch (state.sortBy) {
      case 'affinity':
      case 'postCreatedAt':
      case 'savedAt':
        return dir * (_sortKey.get(a) - _sortKey.get(b));
      case 'score':
        return dir * ((a.score||0) - (b.score||0));
      case 'subreddit':
        return dir * (a.subreddit||'').localeCompare(b.subreddit||'');
      case 'title':
        return dir * (a.title||'').localeCompare(b.title||'');
      case 'rating':
        return dir * ((a.rating||0) - (b.rating||0));
      default: // savedAt fallback
        return dir * ((new Date(a.savedAt||0)) - (new Date(b.savedAt||0)));
    }
  });

  // Author boost only applies when searching and not already using affinity
  if (applyAuthorBoost && state.search.trim() && state.sortBy !== 'affinity') {
    const BOOST_THRESHOLD = 3;
    return sorted.sort((a, b) => {
      const freqA = (a.author && state.authorFreq[a.author] >= BOOST_THRESHOLD) ? 1 : 0;
      const freqB = (b.author && state.authorFreq[b.author] >= BOOST_THRESHOLD) ? 1 : 0;
      return freqB - freqA;
    });
  }
  return sorted;
}

export function filteredItems() {
  let items = state.items;

  // Deleted view — only permanently deleted items
  if (state.showDeleted) return sortItems(items.filter(i => i.isPermanentlyDeleted));

  // Trash view — only disliked (non-permanently-deleted) items
  if (state.showTrash) return sortItems(items.filter(i => i.isDisliked && !i.isPermanentlyDeleted));

  // Normal browse — exclude disliked, permanently deleted, and dead unless filtering for dead
  {
    const wantDead = state.showDead;
    const wantFav = state.filterFavourite;
    items = items.filter(i => {
      if (i.isDisliked || i.isPermanentlyDeleted) return false;
      if (wantDead ? i.enrichStatus !== 'dead' : i.enrichStatus === 'dead') return false;
      if (wantFav && !i.isFavourite) return false;
      return true;
    });
  }

  // Active tag chips — use pre-computed cache for fast Set lookups
  if (state.activeTagIds.length > 0) {
    if (state.tagMode === 'OR') {
      const unionIds = new Set();
      for (const id of state.activeTagIds) {
        const cached = state.tagCache.get(id);
        if (cached) cached.itemIds.forEach(iid => unionIds.add(iid));
        else {
          // Fallback if cache missing
          const list = state.lists.find(l => l.id === id);
          if (list) {
            const tokens = parseSearchQuery(list.query || '');
            items.forEach(i => { if (tokens.length === 0 || itemMatchesTokens(i, tokens)) unionIds.add(i.id); });
          }
        }
      }
      items = items.filter(i => unionIds.has(i.id));
    } else {
      // AND: item must be in every tag's set
      for (const id of state.activeTagIds) {
        const cached = state.tagCache.get(id);
        if (cached) {
          items = items.filter(i => cached.itemIds.has(i.id));
        } else {
          const list = state.lists.find(l => l.id === id);
          if (list) {
            const tokens = parseSearchQuery(list.query || '');
            items = items.filter(i => tokens.length === 0 || itemMatchesTokens(i, tokens));
          }
        }
      }
    }
  }

  // Type filter (panel or search token)
  let typeOverride = null;
  if (state.search.trim()) {
    const tokens = cachedParseSearch(state.search);
    const typeToken = tokens.find(t => t.type === 'typeFilter' && !t.negate);
    if (typeToken) typeOverride = typeToken.value;
    const filterTokens = tokens.filter(t => t.type !== 'typeFilter' || t.negate);
    if (filterTokens.length) items = items.filter(i => itemMatchesTokens(i, filterTokens));
  }
  const effectiveType = typeOverride || state.filterType;
  if (effectiveType !== 'all') items = items.filter(i => i.type === effectiveType);

  // Filter panel — single-pass for rating, links, date, subreddit, author
  {
    const hasRating = state.filterRating > 0;
    const hasLinks = state.filterHasLinks;
    const hasDate = state.filterDateFrom || state.filterDateTo;
    const subTrim = state.filterSubreddit.trim().toLowerCase();
    const authTrim = state.filterAuthor.trim().toLowerCase();

    if (hasRating || hasLinks || hasDate || subTrim || authTrim) {
      const urlRe = hasLinks ? /https?:\/\/\S+/ : null;
      const dateField = hasDate ? state.filterDateField : null;
      const dateFrom = hasDate && state.filterDateFrom ? new Date(state.filterDateFrom).getTime() : 0;
      const dateTo = hasDate && state.filterDateTo ? new Date(state.filterDateTo).getTime() + 86399999 : Infinity;

      items = items.filter(i => {
        if (hasRating && (i.rating || 0) < state.filterRating) return false;
        if (hasLinks && !urlRe.test(i.body || '') && !urlRe.test(i.url || '')) return false;
        if (hasDate) {
          const d = new Date(i[dateField] || 0).getTime();
          if (d < dateFrom || d > dateTo) return false;
        }
        if (subTrim && !(i.subreddit || '').toLowerCase().includes(subTrim)) return false;
        if (authTrim && !(i.author || '').toLowerCase().includes(authTrim)) return false;
        return true;
      });
    }
  }

  return sortItems(items, true);
}

// ─── SEARCH HISTORY ──────────────────────────────────────────────────────────

