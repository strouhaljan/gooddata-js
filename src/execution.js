// Copyright (C) 2007-2014, GoodData(R) Corporation. All rights reserved.
import md5 from 'md5';
import invariant from 'invariant';
import {
    compact,
    filter,
    first,
    find,
    map,
    every,
    get,
    isEmpty,
    isString,
    negate,
    last,
    assign,
    partial,
    flatten,
    omit
} from 'lodash';

import {
    ajax,
    post,
    get as xhrGet,
    parseJSON
} from './xhr';

import Rules from './utils/rules';
import { sortDefinitions } from './utils/definitions';

const notEmpty = negate(isEmpty);

const findHeaderForMappingFn = (mapping, header) =>
    ((mapping.element === header.id || mapping.element === header.uri) &&
        header.measureIndex === undefined);


const wrapMeasureIndexesFromMappings = (metricMappings, headers) => {
    if (metricMappings) {
        metricMappings.forEach((mapping) => {
            const header = find(headers, partial(findHeaderForMappingFn, mapping));
            if (header) {
                header.measureIndex = mapping.measureIndex;
                header.isPoP = mapping.isPoP;
            }
        });
    }
    return headers;
};

/**
 * Module for execution on experimental execution resource
 *
 * @class execution
 * @module execution
 */

/**
 * For the given projectId it returns table structure with the given
 * elements in column headers.
 *
 * @method getData
 * @param {String} projectId - GD project identifier
 * @param {Array} columns - An array of attribute or metric identifiers.
 * @param {Object} executionConfiguration - Execution configuration - can contain for example
 *                 property "filters" containing execution context filters
 *                 property "where" containing query-like filters
 *                 property "orderBy" contains array of sorted properties to order in form
 *                      [{column: 'identifier', direction: 'asc|desc'}]
 * @param {Object} settings - Set "extended" to true to retrieve the result
 *                            including internal attribute IDs (useful to construct filters
 *                            for subsequent report execution requests).
 *                             Supports additional settings accepted by the underlying
 *                             xhr.ajax() calls
 *
 * @return {Object} Structure with `headers` and `rawData` keys filled with values from execution.
 */
export function getData(projectId, columns, executionConfiguration = {}, settings = {}) {
    const executedReport = {
        isLoaded: false
    };

    // Extended result exposes internal attribute element IDs which can
    // be used when constructing executionConfiguration filters for
    // subsequent report execution requests
    const resultKey = settings.extended ? 'extendedTabularDataResult' : 'tabularDataResult';
    // Create request and result structures
    const request = {
        execution: { columns }
    };
    // enrich configuration with supported properties such as
    // where clause with query-like filters or execution context filters
    ['filters', 'where', 'orderBy', 'definitions'].forEach((property) => {
        if (executionConfiguration[property]) {
            request.execution[property] = executionConfiguration[property];
        }
    });

    // Execute request
    return post(`/gdc/internal/projects/${projectId}/experimental/executions`, {
        ...settings,
        body: JSON.stringify(request)
    })
    .then(parseJSON)
    .then((result) => {
        executedReport.headers = wrapMeasureIndexesFromMappings(
            get(executionConfiguration, 'metricMappings'), result.executionResult.headers);

        // Start polling on url returned in the executionResult for tabularData
        return ajax(result.executionResult[resultKey], settings);
    })
    .then((r) => {
        if (r.status === 204) {
            return {
                status: r.status,
                result: ''
            };
        }

        return r.json().then((result) => {
            return {
                status: r.status,
                result
            };
        });
    })
    .then((r) => {
        const { result, status } = r;

        return Object.assign({}, executedReport, {
            rawData: get(result, `${resultKey}.values`, []),
            warnings: get(result, `${resultKey}.warnings`, []),
            isLoaded: true,
            isEmpty: status === 204
        });
    });
}

const MAX_TITLE_LENGTH = 255;
const getMetricTitle = (suffix, title) => {
    const maxLength = MAX_TITLE_LENGTH - suffix.length;
    if (title && title.length > maxLength) {
        if (title[title.length - 1] === ')') {
            return `${title.substring(0, maxLength - 2)}…)${suffix}`;
        }
        return `${title.substring(0, maxLength - 1)}…${suffix}`;
    }
    return `${title}${suffix}`;
};

const getBaseMetricTitle = partial(getMetricTitle, '');

const POP_SUFFIX = ' - previous year';
const getPoPMetricTitle = partial(getMetricTitle, POP_SUFFIX);

const CONTRIBUTION_METRIC_FORMAT = '#,##0.00%';

const allFiltersEmpty = item => every(map(
    get(item, 'measureFilters', []),
    f => isEmpty(get(f, 'listAttributeFilter.default.attributeElements', []))
));

const isDerived = (measure) => {
    const type = get(measure, 'type');
    return (type === 'fact' || type === 'attribute' || !allFiltersEmpty(measure));
};

const getFilterExpression = (listAttributeFilter) => {
    const attributeUri = get(listAttributeFilter, 'listAttributeFilter.attribute');
    const elements = get(listAttributeFilter, 'listAttributeFilter.default.attributeElements', []);
    if (isEmpty(elements)) {
        return null;
    }
    const elementsForQuery = map(elements, e => `[${e}]`);
    const negative = get(listAttributeFilter, 'listAttributeFilter.default.negativeSelection') ? 'NOT ' : '';

    return `[${attributeUri}] ${negative}IN (${elementsForQuery.join(',')})`;
};

const getGeneratedMetricExpression = (item) => {
    const aggregation = get(item, 'aggregation', '').toUpperCase();
    const objectUri = get(item, 'objectUri');
    const where = filter(map(get(item, 'measureFilters'), getFilterExpression), e => !!e);

    return `SELECT ${aggregation ? `${aggregation}([${objectUri}])` : `[${objectUri}]`
        }${notEmpty(where) ? ` WHERE ${where.join(' AND ')}` : ''}`;
};

const getPercentMetricExpression = ({ category }, measure) => {
    let metricExpressionWithoutFilters = `SELECT [${get(measure, 'objectUri')}]`;

    if (isDerived(measure)) {
        metricExpressionWithoutFilters = getGeneratedMetricExpression(omit(measure, 'measureFilters'));
    }

    const attributeUri = get(category, 'attribute');
    const whereFilters = filter(map(get(measure, 'measureFilters'), getFilterExpression), e => !!e);
    const whereExpression = notEmpty(whereFilters) ? ` WHERE ${whereFilters.join(' AND ')}` : '';

    return `SELECT (${metricExpressionWithoutFilters}${whereExpression}) / (${metricExpressionWithoutFilters} BY ALL [${attributeUri}]${whereExpression})`;
};

const getPoPExpression = (attribute, metricExpression) => {
    const attributeUri = get(attribute, 'attribute');

    return `SELECT ${metricExpression} FOR PREVIOUS ([${attributeUri}])`;
};

const getGeneratedMetricHash = (title, format, expression) => md5(`${expression}#${title}#${format}`);

const getGeneratedMetricIdentifier = (item, aggregation, expressionCreator, hasher) => {
    const [, , , prjId, , id] = get(item, 'objectUri').split('/');
    const identifier = `${prjId}_${id}`;
    const hash = hasher(expressionCreator(item));
    const hasNoFilters = isEmpty(get(item, 'measureFilters', []));
    const type = get(item, 'type');

    const prefix = (hasNoFilters || allFiltersEmpty(item)) ? '' : '_filtered';

    return `${type}_${identifier}.generated.${hash}${prefix}_${aggregation}`;
};

const isDateCategory = ({ category }) => category.type === 'date';
const isDateFilter = ({ dateFilter }) => dateFilter;

const getCategories = ({ categories }) => categories;
const getFilters = ({ filters }) => filters;

const getDateCategory = (mdObj) => {
    const category = find(getCategories(mdObj), isDateCategory);

    return get(category, 'category');
};

const getDateFilter = (mdObj) => {
    const dateFilter = find(getFilters(mdObj), isDateFilter);

    return get(dateFilter, 'dateFilter');
};

const getDate = mdObj => (getDateCategory(mdObj) || getDateFilter(mdObj));

const getMetricSort = (sort, isPoPMetric) => {
    if (isString(sort)) {
        // TODO: backward compatibility, remove when not used plain "sort: asc | desc" in measures
        return sort;
    }

    const sortByPoP = get(sort, 'sortByPoP');
    if ((isPoPMetric && sortByPoP) || (!isPoPMetric && !sortByPoP)) {
        return get(sort, 'direction');
    }
    return null;
};

const createPureMetric = (measure, mdObj, measureIndex) => ({
    element: get(measure, 'objectUri'),
    sort: getMetricSort(get(measure, 'sort')),
    meta: { measureIndex }
});

const createDerivedMetric = (measure, mdObj, measureIndex) => {
    const { format, sort } = measure;
    const title = getBaseMetricTitle(measure.title);

    const hasher = partial(getGeneratedMetricHash, title, format);
    const aggregation = get(measure, 'aggregation', 'base').toLowerCase();
    const element = getGeneratedMetricIdentifier(measure, aggregation, getGeneratedMetricExpression, hasher);
    const definition = {
        metricDefinition: {
            identifier: element,
            expression: getGeneratedMetricExpression(measure),
            title,
            format
        }
    };

    return {
        element,
        definition,
        sort: getMetricSort(sort),
        meta: {
            measureIndex
        }
    };
};

const createContributionMetric = (measure, mdObj, measureIndex) => {
    const category = first(getCategories(mdObj));
    const getMetricExpression = partial(getPercentMetricExpression, category);
    const title = getBaseMetricTitle(get(measure, 'title'));
    const hasher = partial(getGeneratedMetricHash, title, CONTRIBUTION_METRIC_FORMAT);
    return {
        element: getGeneratedMetricIdentifier(measure, 'percent', getMetricExpression, hasher),
        definition: {
            metricDefinition: {
                identifier: getGeneratedMetricIdentifier(measure, 'percent', getMetricExpression, hasher),
                expression: getMetricExpression(measure),
                title,
                format: CONTRIBUTION_METRIC_FORMAT
            }
        },
        sort: getMetricSort(get(measure, 'sort')),
        meta: {
            measureIndex
        }
    };
};

const createPoPMetric = (measure, mdObj, measureIndex) => {
    const title = getPoPMetricTitle(get(measure, 'title'));
    const format = get(measure, 'format');
    const hasher = partial(getGeneratedMetricHash, title, format);

    const date = getDate(mdObj);

    let generated;
    let getMetricExpression = partial(getPoPExpression, date, `[${get(measure, 'objectUri')}]`);

    if (isDerived(measure)) {
        generated = createDerivedMetric(measure, mdObj, measureIndex);
        getMetricExpression = partial(getPoPExpression, date, `(${get(generated, 'definition.metricDefinition.expression')})`);
    }

    const identifier = getGeneratedMetricIdentifier(measure, 'pop', getMetricExpression, hasher);

    const result = [{
        element: identifier,
        definition: {
            metricDefinition: {
                identifier,
                expression: getMetricExpression(),
                title,
                format
            }
        },
        sort: getMetricSort(get(measure, 'sort'), true),
        meta: {
            measureIndex,
            isPoP: true
        }
    }];

    if (generated) {
        result.push(generated);
    } else {
        result.push(createPureMetric(measure, mdObj, measureIndex));
    }

    return result;
};

const createContributionPoPMetric = (measure, mdObj, measureIndex) => {
    const date = getDate(mdObj);

    const generated = createContributionMetric(measure, mdObj, measureIndex);
    const title = getPoPMetricTitle(get(measure, 'title'));

    const format = CONTRIBUTION_METRIC_FORMAT;
    const hasher = partial(getGeneratedMetricHash, title, format);

    const getMetricExpression = partial(getPoPExpression, date, `(${get(generated, 'definition.metricDefinition.expression')})`);

    const identifier = getGeneratedMetricIdentifier(measure, 'pop', getMetricExpression, hasher);

    const result = [{
        element: identifier,
        definition: {
            metricDefinition: {
                identifier,
                expression: getMetricExpression(),
                title,
                format
            }
        },
        sort: getMetricSort(get(measure, 'sort'), true),
        meta: {
            measureIndex,
            isPoP: true
        }
    }];

    result.push(generated);

    return result;
};

const categoryToElement = ({ category }) =>
    ({ element: get(category, 'displayForm'), sort: get(category, 'sort') });

const attributeFilterToWhere = (f) => {
    const elements = get(f, 'listAttributeFilter.default.attributeElements', []);
    const elementsForQuery = map(elements, e => ({ id: last(e.split('=')) }));

    const dfUri = get(f, 'listAttributeFilter.displayForm');
    const negative = get(f, 'listAttributeFilter.default.negativeSelection');

    return negative ?
        { [dfUri]: { $not: { $in: elementsForQuery } } } :
        { [dfUri]: { $in: elementsForQuery } };
};

const dateFilterToWhere = (f) => {
    const dateUri =
        get(f, 'dateFilter.dimension') ||
        get(f, 'dateFilter.dataSet') ||
        get(f, 'dateFilter.dataset'); // dataset with lowercase 's' is deprecated; kept here for backwards compatibility
    const granularity = get(f, 'dateFilter.granularity');
    const between = [get(f, 'dateFilter.from'), get(f, 'dateFilter.to')];
    return { [dateUri]: { $between: between, $granularity: granularity } };
};

const isPoP = ({ showPoP }) => showPoP;
const isContribution = ({ showInPercent }) => showInPercent;

const isCalculatedMeasure = ({ type }) => type === 'metric';

const rules = new Rules();

rules.addRule(
    [isPoP, isContribution],
    createContributionPoPMetric
);

rules.addRule(
    [isPoP],
    createPoPMetric
);

rules.addRule(
    [isContribution],
    createContributionMetric
);

rules.addRule(
    [isDerived],
    createDerivedMetric
);

rules.addRule(
    [isCalculatedMeasure],
    createPureMetric
);

function getMetricFactory(measure) {
    const factory = rules.match(measure);

    invariant(factory, `Unknown factory for: ${measure}`);

    return factory;
}

const isDateFilterExecutable = dateFilter =>
    get(dateFilter, 'from') !== undefined &&
    get(dateFilter, 'to') !== undefined;

const isAttributeFilterExecutable = listAttributeFilter =>
    notEmpty(get(listAttributeFilter, ['default', 'attributeElements']));


function getWhere(filters) {
    const executableFilters = filter(
        filters, ({ listAttributeFilter }) => isAttributeFilterExecutable(listAttributeFilter)
    );
    const attributeFilters = map(executableFilters, attributeFilterToWhere);
    const dateFilters = map(filter(filters, ({ dateFilter }) => isDateFilterExecutable(dateFilter)), dateFilterToWhere);

    const resultDate = [...dateFilters].reduce(assign, {});
    const resultAttribute = {
        $and: attributeFilters
    };

    return {
        ...resultDate,
        ...resultAttribute
    };
}

const sortToOrderBy = item => ({ column: get(item, 'element'), direction: get(item, 'sort') });

const getOrderBy = (metrics, categories, type) => {
    // For bar chart we always override sorting to sort by values (first metric)
    if (type === 'bar' && notEmpty(metrics)) {
        return [{
            column: first(compact(map(metrics, 'element'))),
            direction: 'desc'
        }];
    }

    return map(filter([...categories, ...metrics], item => item.sort), sortToOrderBy);
};

export const mdToExecutionConfiguration = (mdObj, options = {}) => {
    const buckets = get(mdObj, 'buckets');
    const measures = map(buckets.measures, ({ measure }) => measure);
    const metrics = flatten(map(measures, (measure, index) => getMetricFactory(measure)(measure, buckets, index)));

    let categories = getCategories(buckets);
    let filters = getFilters(buckets);
    if (options.removeDateItems) {
        categories = filter(categories, ({ category }) => category.type !== 'date');
        filters = filter(filters, item => !item.dateFilter);
    }
    categories = map(categories, categoryToElement);

    const columns = compact(map([...categories, ...metrics], 'element'));

    return {
        columns,
        orderBy: getOrderBy(metrics, categories, get(mdObj, 'type')),
        definitions: sortDefinitions(compact(map(metrics, 'definition'))),
        where: columns.length ? getWhere(filters) : {},
        metricMappings: map(metrics, m => ({ element: m.element, ...m.meta }))
    };
};

const getOriginalMetricFormats = (mdObj) => {
    // for metrics with showPoP or measureFilters.length > 0 roundtrip for original metric format
    return Promise.all(map(
        map(get(mdObj, 'buckets.measures'), ({ measure }) => measure),
        (measure) => {
            if (measure.showPoP === true || measure.measureFilters.length > 0) {
                return xhrGet(measure.objectUri).then((obj) => {
                    return {
                        ...measure,
                        format: get(obj, 'metric.content.format', measure.format)
                    };
                });
            }

            return Promise.resolve(measure);
        }
    ));
};

export const getDataForVis = (projectId, mdObj, settings) => {
    return getOriginalMetricFormats(mdObj).then((measures) => {
        const metadata = mdObj;
        metadata.buckets.measures = map(measures, measure => ({ measure }));
        const { columns, ...executionConfiguration } = mdToExecutionConfiguration(mdObj);
        return getData(projectId, columns, executionConfiguration, settings);
    });
};
