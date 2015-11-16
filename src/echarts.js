/**
 * @module echarts
 */
define(function (require) {

    var GlobalModel = require('./model/Global');
    var ExtensionAPI = require('./ExtensionAPI');
    var CoordinateSystemManager = require('./CoordinateSystem');

    var ComponentModel = require('./model/Component');
    var SeriesModel = require('./model/Series');

    var ComponentView = require('./view/Component');
    var ChartView = require('./view/Chart');

    var scaleClasses = require('./scale/scale');

    var zrender = require('zrender');
    var zrUtil = require('zrender/core/util');
    var colorTool = require('zrender/tool/color');
    var env = require('zrender/core/env');
    var Eventful = require('zrender/mixin/Eventful');

    var each = zrUtil.each;

    var VISUAL_CODING_STAGES = ['echarts', 'chart', 'component'];

    // TODO Transform first or filter first
    var PROCESSOR_STAGES = ['transform', 'filter', 'statistic'];

    /**
     * @module echarts~ECharts
     */
    function ECharts (dom, theme, opts) {
        opts = opts || {};

        /**
         * @type {string}
         */
        this.id;
        /**
         * Group id
         * @type {string}
         */
        this.group;
        /**
         * @type {HTMLDomElement}
         * @private
         */
        this._dom = dom;
        /**
         * @type {module:zrender/ZRender}
         * @private
         */
        this._zr = zrender.init(dom, {
            renderer: opts.renderer || 'canvas'
        });

        /**
         * @type {Object}
         * @private
         */
        this._theme = zrUtil.clone(theme);

        /**
         * @type {Array.<module:echarts/view/Chart>}
         * @private
         */
        this._chartsList = [];

        /**
         * @type {Object.<string, module:echarts/view/Chart>}
         * @private
         */
        this._chartsMap = {};

        /**
         * @type {Array.<module:echarts/view/Component>}
         * @private
         */
        this._componentsList = [];

        /**
         * @type {Object.<string, module:echarts/view/Component>}
         * @private
         */
        this._componentsMap = {};

        /**
         * @type {module:echarts/ExtensionAPI}
         * @private
         */
        this._extensionAPI = new ExtensionAPI(this);

        /**
         * @type {module:echarts/CoordinateSystem}
         * @private
         */
        this._coordinateSystem = new CoordinateSystemManager();

        Eventful.call(this);

        // Init mouse events
        this._initEvents();

        // In case some people write `window.onresize = chart.resize`
        this.resize = zrUtil.bind(this.resize, this);
    }

    var echartsProto = ECharts.prototype;

    echartsProto.getDom = function () {
        return this._dom;
    };

    echartsProto.getZr = function () {
        return this._zr;
    };

    echartsProto.setOption = function (option, notMerge, refreshImmediately) {
        // PENDING
        option = zrUtil.clone(option, true);

        each(optionPreprocessorFuncs, function (preProcess) {
            preProcess(option);
        });

        var ecModel = this._model;
        if (!ecModel || notMerge) {
            ecModel = new GlobalModel(option, null, this._theme);
            this._model = ecModel;
        }
        else {
            ecModel.restoreData();
            ecModel.mergeOption(option);
        }

        this._prepareComponents(ecModel);

        this._prepareCharts(ecModel);

        this.update();

        refreshImmediately && this._zr.refreshImmediately();
    };

    /**
     * @return {module:echarts/model/Global}
     */
    echartsProto.getModel = function () {
        return this._model;
    };

    /**
     * @return {number}
     */
    echartsProto.getWidth = function () {
        return this._zr.getWidth();
    };

    /**
     * @return {number}
     */
    echartsProto.getHeight = function () {
        return this._zr.getHeight();
    };

    /**
     * @param {Object} payload
     */
    echartsProto.update = function (payload) {
        console.time && console.time('update');

        var ecModel = this._model;

        ecModel.restoreData();

        // TODO
        // Save total ecModel here for undo/redo (after restoring data and before processing data).
        // Undo (restoration of total ecModel) can be carried out in 'action' or outside API call.

        this._processData(ecModel);

        this._stackSeriesData(ecModel);

        this._coordinateSystem.update(ecModel, this._extensionAPI);

        this._doLayout(ecModel, payload);

        this._doVisualCoding(ecModel, payload);

        this._doRender(ecModel, payload);

        // Set background
        var backgroundColor = ecModel.get('backgroundColor');
        // In IE8
        if (!env.canvasSupported) {
            var colorArr = colorTool.parse(backgroundColor);
            backgroundColor = colorTool.stringify(colorArr, 'rgb');
            if (colorArr[3] === 0) {
                backgroundColor = 'transparent';
            }
        }
        backgroundColor && (this._dom.style.backgroundColor = backgroundColor);

        console.time && console.timeEnd('update');
    };

    // PENDING
    /**
     * @param {Object} payload
     */
    echartsProto.updateView = function (payload) {
        var ecModel = this._model;

        this._doLayout(ecModel, payload);

        this._doVisualCoding(ecModel, payload);

        this._invokeUpdateMethod('updateView', ecModel, payload);
    };

    /**
     * @param {Object} payload
     */
    echartsProto.updateVisual = function (payload) {
        var ecModel = this._model;

        this._doVisualCoding(ecModel, payload);

        this._invokeUpdateMethod('updateVisual', ecModel, payload);
    };

    /**
     * @param {Object} payload
     */
    echartsProto.updateLayout = function (payload) {
        var ecModel = this._model;

        this._doLayout(ecModel, payload);

        this._invokeUpdateMethod('updateLayout', ecModel, payload);
    };

    /**
     * Resize the chart
     */
    echartsProto.resize = function () {
        this._zr.resize();
        this.update();
    };

    /**
     * @param {Object} eventObj
     * @return {Object}
     */
    echartsProto.makeActionFromEvent = function (eventObj) {
        var payload = zrUtil.extend({}, eventObj);
        payload.type = eventActionMap[eventObj.type];
        return payload;
    };

    /**
     * @pubilc
     * @param {Object} payload
     * @param {string} [payload.type] Action type
     * @param {boolean} [silent=false] Whether trigger event.
     * @param {number} [payload.from] From uid
     */
    echartsProto.dispatch = function (payload, silent) {
        var actionWrap = actions[payload.type];
        if (actionWrap) {
            var actionInfo = actionWrap.actionInfo;
            var updateMethod = actionInfo.update || 'update';
            actionWrap.action(payload, this._model);
            updateMethod !== 'none' && this[updateMethod](payload);

            if (!silent) {
                // Emit event outside
                // Convert type to eventType
                var eventObj = zrUtil.extend({}, payload);
                eventObj.type = actionInfo.event || eventObj.type;
                this.trigger(eventObj.type, eventObj);
            }
        }
    };

    /**
     * @param {string} methodName
     * @private
     */
    echartsProto._invokeUpdateMethod = function (methodName, ecModel, payload) {
        var api = this._extensionAPI;

        // Update all components
        each(this._componentsList, function (component) {
            var componentModel = component.__model;
            component[methodName](componentModel, ecModel, api, payload);

            updateZ(componentModel, component);
        }, this);

        // Upate all charts
        ecModel.eachSeries(function (seriesModel, idx) {
            var chart = this._chartsMap[seriesModel.getId()];
            chart[methodName](seriesModel, ecModel, api, payload);

            updateZ(seriesModel, chart);
        }, this);

    };

    /**
     * Prepare charts view instances
     * @param  {module:echarts/model/Global} ecModel
     * @private
     */
    echartsProto._prepareCharts = function (ecModel) {

        var chartsList = this._chartsList;
        var chartsMap = this._chartsMap;
        var zr = this._zr;

        for (var i = 0; i < chartsList.length; i++) {
            chartsList[i].__keepAlive = false;
        }

        ecModel.eachSeries(function (seriesModel, idx) {
            var id = seriesModel.getId();

            var chart = chartsMap[id];
            if (!chart) {
                var Clazz = ChartView.getClass(
                    ComponentModel.parseComponentType(seriesModel.type).sub
                );
                if (Clazz) {
                    chart = new Clazz();
                    chart.init(ecModel, this._extensionAPI);
                    chartsMap[id] = chart;
                    chartsList.push(chart);
                    zr.add(chart.group);
                }
                else {
                    // Error
                }
            }

            chart.__keepAlive = true;
            chart.__id = id;
        }, this);

        for (var i = 0; i < chartsList.length;) {
            var chart = chartsList[i];
            if (!chart.__keepAlive) {
                zr.remove(chart.group);
                chart.dispose(this._extensionAPI);
                chartsList.splice(i, 1);
                delete chartsMap[chart.__id];
            }
            else {
                i++;
            }
        }
    };

    /**
     * Prepare component view instances
     * @param  {module:echarts/model/Global} ecModel
     * @private
     */
    echartsProto._prepareComponents = function (ecModel) {

        var componentsMap = this._componentsMap;
        var componentsList = this._componentsList;

        for (var i = 0; i < componentsList.length; i++) {
            componentsList[i].__keepAlive = true;
        }

        ecModel.eachComponent(function (componentType, componentModel) {
            if (componentType === 'series') {
                return;
            }

            var id = componentModel.getId();
            var component = componentsMap[id];
            if (!component) {
                // Create and add component
                var Clazz = ComponentView.getClass(
                    componentType, componentModel.option.type
                );

                if (Clazz) {
                    component = new Clazz();
                    component.init(ecModel, this._extensionAPI);
                    componentsMap[id] = component;
                    componentsList.push(component);

                    this._zr.add(component.group);
                }
            }
            component.__id = id;
            component.__keepAlive = true;
            // Used in rendering
            component.__model = componentModel;
        }, this);

        for (var i = 0; i < componentsList.length;) {
            var component = componentsList[i];
            if (!component.__keepAlive) {
                this._zr.remove(component.group);
                component.dispose(this._extensionAPI);
                componentsList.splice(i, 1);
                delete componentsMap[component.__id];
            }
            else {
                i++;
            }
        }
    };

    /**
     * Processor data in each series
     *
     * @param {module:echarts/model/Global} ecModel
     * @private
     */
    echartsProto._processData = function (ecModel) {
        each(PROCESSOR_STAGES, function (stage) {
            each(dataProcessorFuncs[stage] || [], function (process) {
                process(ecModel);
            });
        });
    };

    /**
     * @private
     */
    echartsProto._stackSeriesData = function (ecModel) {
        var stackedDataMap = {};
        ecModel.eachSeries(function (series) {
            var stack = series.get('stack');
            var data = series.getData();
            if (stack && data.type === 'list') {
                var previousStack = stackedDataMap[stack];
                if (previousStack) {
                    data.stackedOn = previousStack;
                }
                stackedDataMap[stack] = data;
            }
        });
    };

    /**
     * Layout before each chart render there series, after visual coding and data processing
     *
     * @param {module:echarts/model/Global} ecModel
     * @private
     */
    echartsProto._doLayout = function (ecModel, payload) {
        var api = this._extensionAPI;
        each(layoutFuncs, function (layout) {
            layout(ecModel, api, payload);
        });
    };

    /**
     * Code visual infomation from data after data processing
     *
     * @param {module:echarts/model/Global} ecModel
     * @private
     */
    echartsProto._doVisualCoding = function (ecModel, payload) {
        each(VISUAL_CODING_STAGES, function (stage) {
            each(visualCodingFuncs[stage] || [], function (visualCoding) {
                visualCoding(ecModel, payload);
            });
        });
    };

    /**
     * Render each chart and component
     * @private
     */
    echartsProto._doRender = function (ecModel, payload) {
        var api = this._extensionAPI;
        // Render all components
        each(this._componentsList, function (component) {
            var componentModel = component.__model;
            component.render(componentModel, ecModel, api, payload);

            updateZ(componentModel, component);
        }, this);

        each(this._chartsList, function (chart) {
            chart.__keepAlive = false;
        }, this);

        // Render all charts
        ecModel.eachSeries(function (seriesModel, idx) {
            var chart = this._chartsMap[seriesModel.getId()];
            chart.__keepAlive = true;
            chart.render(seriesModel, ecModel, api, payload);

            updateZ(seriesModel, chart);
        }, this);

        // Remove groups of unrendered charts
        each(this._chartsList, function (chart) {
            if (!chart.__keepAlive) {
                chart.remove(ecModel, api);
            }
        }, this);
    };

    var MOUSE_EVENT_NAMES = [
        'click', 'dblclick', 'mouseover', 'mouseout', 'globalout'
    ];
    /**
     * @private
     */
    echartsProto._initEvents = function () {
        var zr = this._zr;
        each(MOUSE_EVENT_NAMES, function (eveName) {
            zr.on(eveName, function (e) {
                var ecModel = this.getModel();
                var el = e.target;
                if (el && el.dataIndex != null) {
                    var hostModel = el.hostModel || ecModel.getSeriesByIndex(
                        el.seriesIndex, true
                    );
                    var params = hostModel && hostModel.getDataParams(el.dataIndex) || {};
                    params.event = e;
                    params.type = eveName;
                    this.trigger(eveName, params);
                }
            }, this);
        }, this);
    };

    /**
     * @return {boolean]
     */
    echartsProto.isDisposed = function () {
        return this._disposed;
    };
    /**
     * Dispose instance
     */
    echartsProto.dispose = function () {
        this._disposed = true;

        each(this._components, function (component) {
            component.dispose();
        });
        each(this._charts, function (chart) {
            chart.dispose();
        });

        this.zr.dispose();

        instances[this.id] = null;
    };

    zrUtil.mixin(ECharts, Eventful);

    /**
     * @param {module:echarts/model/Series|module:echarts/model/Component} model
     * @param {module:echarts/view/Component|module:echarts/view/Chart} view
     * @return {string}
     */
    function updateZ(model, view) {
        var z = model.get('z');
        var zlevel = model.get('zlevel');
        // Set z and zlevel
        view.group.traverse(function (el) {
            z != null && (el.z = z);
            zlevel != null && (el.zlevel = zlevel);
        });
    }
    /**
     * @type {Array.<Function>}
     * @inner
     */
    var actions = [];

    /**
     * Map eventType to actionType
     * @type {Object}
     */
    var eventActionMap = {};

    /**
     * @type {Array.<Function>}
     * @inner
     */
    var layoutFuncs = [];

    /**
     * Data processor functions of each stage
     * @type {Array.<Object.<string, Function>>}
     * @inner
     */
    var dataProcessorFuncs = {};

    /**
     * @type {Array.<Function>}
     * @inner
     */
    var optionPreprocessorFuncs = [];

    /**
     * Visual coding functions of each stage
     * @type {Array.<Object.<string, Function>>}
     * @inner
     */
    var visualCodingFuncs = {};

    var instances = {};
    var connectedGroups = {};

    var idBase = new Date() - 0;
    var groupIdBase = new Date() - 0;
    var DOM_ATTRIBUTE_KEY = '_echarts_instance_';
    /**
     * @alias module:echarts
     */
    var echarts = {
        /**
         * @type {number}
         */
        version: '3.0.0',
        dependencies: {
            zrender: '3.0.0'
        }
    };

    /**
     * @param {HTMLDomElement} dom
     * @param {Object} [theme]
     * @param {Object} opts
     */
    echarts.init = function (dom, theme, opts) {
        // Check version
        if ((zrender.version.replace('.', '') - 0) < (echarts.dependencies.zrender.replace('.', '') - 0)) {
            console.error(
                'ZRender ' + zrender.version
                + ' is too old for ECharts ' + echarts.version
                + '. Current version need ZRender '
                + echarts.dependencies.zrender + '+'
            );
        }

        var chart = new ECharts(dom, theme, opts);
        chart.id = idBase++;
        instances[chart.id] = chart;

        // Connecting
        zrUtil.each(eventActionMap, function (actionType, eventType) {
            chart.on(eventType, function (event) {
                if (connectedGroups[chart.group]) {
                    chart.__connectedActionDispatching = true;
                    for (var id in instances) {
                        var action = chart.makeActionFromEvent(event);
                        var otherChart = instances[id];
                        if (otherChart !== chart && otherChart.group === chart.group) {
                            if (!otherChart.__connectedActionDispatching) {
                                otherChart.dispatch(action);
                            }
                        }
                    }
                    chart.__connectedActionDispatching = false;
                }
            });
        });

        return chart;
    };

    /**
     * @return {string|Array.<module:echarts~ECharts>} groupId
     */
    echarts.connect = function (groupId) {
        // Is array of charts
        if (zrUtil.isArray(groupId)) {
            var charts = groupId;
            groupId = null;
            // If any chart has group
            zrUtil.each(charts, function (chart) {
                if (chart.group != null) {
                    groupId = chart.group;
                }
            });
            groupId = groupId || groupIdBase++;
            zrUtil.each(charts, function (chart) {
                chart.group = groupId;
            });
        }
        connectedGroups[groupId] = true;
        return groupId;
    };

    /**
     * @return {string} groupId
     */
    echarts.disConnect = function (groupId) {
        connectedGroups[groupId] = false;
    };

    /**
     * Dispose a chart instance
     * @param  {module:echarts~ECharts|HTMLDomElement|string} chart
     */
    echarts.dispose = function (chart) {
        if (zrUtil.isDom(chart)) {
            chart = echarts.getInstanceByDom(chart);
        }
        else if (typeof chart === 'string') {
            chart = instances[chart];
        }
        if ((chart instanceof ECharts) && !chart.isDisposed()) {
            chart.dispose();
        }
    };

    /**
     * @param  {HTMLDomElement} dom
     * @return {echarts~ECharts}
     */
    echarts.getInstanceByDom = function (dom) {
        var key = dom.getAttribute(DOM_ATTRIBUTE_KEY);
        return instances[key];
    };
    /**
     * @param {string} key
     * @return {echarts~ECharts}
     */
    echarts.getInstanceById = function (key) {
        return instances[key];
    };

    /**
     * Register option preprocessor
     * @param {Function} preprocessorFunc
     */
    echarts.registerPreprocessor = function (preprocessorFunc) {
        optionPreprocessorFuncs.push(preprocessorFunc);
    };

    /**
     * @param {string} stage
     * @param {Function} processorFunc
     */
    echarts.registerProcessor = function (stage, processorFunc) {
        if (zrUtil.indexOf(PROCESSOR_STAGES, stage) < 0) {
            throw new Error('stage should be one of ' + PROCESSOR_STAGES);
        }
        var funcs = dataProcessorFuncs[stage] || (dataProcessorFuncs[stage] = []);
        funcs.push(processorFunc);
    };

    /**
     * Usage:
     * registerAction('someAction', 'someEvent', function () { ... });
     * registerAction('someAction', function () { ... });
     * registerAction(
     *     {type: 'someAction', event: 'someEvent', update: 'updateView'},
     *     function () { ... }
     * );
     *
     * @param {(string|Object)} actionInfo
     * @param {string} actionInfo.type
     * @param {string} [actionInfo.event]
     * @param {string} [actionInfo.update]
     * @param {string} [eventName]
     * @param {Function} action
     */
    echarts.registerAction = function (actionInfo, eventName, action) {
        if (typeof eventName === 'function') {
            action = eventName;
            eventName = '';
        }
        var actionType = zrUtil.isObject(actionInfo)
            ? actionInfo.type
            : ([actionInfo, actionInfo = {
                event: eventName
            }][0]);

        actionInfo.event = actionInfo.event || actionType;
        eventName = actionInfo.event;

        if (!actions[actionType]) {
            actions[actionType] = {action: action, actionInfo: actionInfo};
        }
        eventActionMap[eventName] = actionType;
    };

    /**
     * @param {string} type
     * @param {*} CoordinateSystem
     */
    echarts.registerCoordinateSystem = function (type, CoordinateSystem) {
        CoordinateSystemManager.register(type, CoordinateSystem);
    };

    /**
     * @param {*} layout
     */
    echarts.registerLayout = function (layout) {
        // PENDING All functions ?
        if (zrUtil.indexOf(layoutFuncs, layout) < 0) {
            layoutFuncs.push(layout);
        }
    };

    /**
     * @param {string} stage
     * @param {Function} visualCodingFunc
     */
    echarts.registerVisualCoding = function (stage, visualCodingFunc) {
        if (zrUtil.indexOf(VISUAL_CODING_STAGES, stage) < 0) {
            throw new Error('stage should be one of ' + VISUAL_CODING_STAGES);
        }
        var funcs = visualCodingFuncs[stage] || (visualCodingFuncs[stage] = []);
        funcs.push(visualCodingFunc);
    };

    /**
     * @param {echarts/scale/*} scale
     */
    echarts.registerScale = function (scale) {
        scaleClasses.register(scale);
    };

    /**
     * @param {Object} opts
     */
    echarts.extendChartView = function (opts) {
        return ChartView.extend(opts);
    };

    /**
     * @param {Object} opts
     */
    echarts.extendComponentModel = function (opts) {
        return ComponentModel.extend(opts);
    };

    /**
     * @param {Object} opts
     */
    echarts.extendSeriesModel = function (opts) {
        return SeriesModel.extend(opts);
    };

    /**
     * @param {Object} opts
     */
    echarts.extendComponentView = function (opts) {
        return ComponentView.extend(opts);
    };

    echarts.registerVisualCoding('echarts', require('./visual/seriesColor'));

    echarts.registerPreprocessor(require('./preprocessor/backwardCompat'));

    return echarts;
});