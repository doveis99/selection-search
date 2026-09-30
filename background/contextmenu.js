

function ContextMenu(options, _clickCounterCallback){


    let _rootItem = 'ss-context-menu-root'
    let _captureItem = 'ss-context-menu-capture'
    let _imageItem = 'ss-context-menu-image'
    let _options = options;
    let _idCounter = 0
    let _onClickCallbacks = {}
    let _createMenuPromise = null;
    let _currentPromise = Promise.resolve();


    this.onItemClicked = function(info, tab){
        _currentPromise.then(() =>{
            _onClickItem(info, tab)
        })
    }

    function getCurrentPromise(){
        if(_currentPromise !== null){
            return _currentPromise.then(() => {
                return Promise.resolve()
            })
        }
        return Promise.resolve()
    }

    this.setSearchEngines = function(engines){
        _currentPromise = doSetEngines(engines, _currentPromise).then(() => {
            _currentPromise = Promise.resolve()
        })
    }

    function doSetEngines(engines, currentPromise){
        return new Promise((resolve, reject) => {
            currentPromise.then(() => {
                _createRootItem().then(() => {
                    _idCounter = 0;
                    _onClickCallbacks = {}
                    _addEngines(engines, _rootItem).then(() =>{
                        return _addCaptureItem()
                    }).then(() =>{
                        return _addImageItem()
                    }).then(() =>{
                        resolve()
                    })
                })
            })
        })
    }


    this.disable = function(){
        _currentPromise = doDisable(_currentPromise).then(()=>{
            _currentPromise = Promise.resolve();
        })
    }

    function doDisable(currentPromise){
        return new Promise((resolve, reject) => {
            currentPromise.then(() => {
                _removeRootItem().then(() => {
                    _idCounter = 0;
                    _onClickCallbacks = {}
                    // The capture items do not depend on the search engines
                    _addCaptureItem().then(() => {
                        return _addImageItem()
                    }).then(() => {
                        resolve()
                    })
                })
            })
        })
    }

    this.setOptions = function(options){
        _options = options;

    }


    function _addEngines(engines, parentItem){
        return new Promise((resolve, reject) => {
            let promises = []
            for(var i in engines){
                promises.push(_addEngine(engines[i], parentItem))
            }
            resolve(Promise.all(promises))
        })
    }


    function _addEngine(engine, parentItem){
        return new Promise((resolve, reject) => {
            if(_options.separate_menus && engine.hide_in_ctx){
                resolve()
            }
            else if(engine.is_submenu){
                resolve(_addSubMenuItem(engine, parentItem))
            }
            else if(engine.is_separator){
                resolve(_addSeparatorItem(engine, parentItem))
            }
            else{
                resolve(_addEngineItem(engine, parentItem))
            }
        })
    }


    function _addEngineItem(engine, parentItem){
        return new Promise((resolve, reject) => {
            let id = _nextItemId()

            let contexts = ['selection'];
            if (_options.allow_engines_without_selection) {
                contexts.push('page');
            }

            chrome.contextMenus.create({
                'id': id,
                'title' :  engine.name,
                'contexts' : contexts,
                'parentId' : parentItem,
            }, function(){
                _registerOnClick(id, function(info, tab){
                    _onEngineClick(engine, info, tab);
                })
                resolve()
            })
        });
    }

    function _addSeparatorItem(engine, parentItem){
        return new Promise((resolve, reject) => {
            let contexts = ['selection'];
            if (_options.allow_engines_without_selection) {
                contexts.push('page');
            }

            chrome.contextMenus.create({
                'id': _nextItemId(),
                'type' : 'separator',
                'contexts' : contexts,
                'parentId' : parentItem,
            }, function(){
                resolve()
            });
        })
    }



    function _addSubMenuItem(engine, parentItem){

        let id = _nextItemId()

        let contexts = ['selection'];
        if (_options.allow_engines_without_selection) {
            contexts.push('page');
        }

        var menu = {
            'id': id,
            'title' :  engine.name,
            'contexts' :  contexts,
            'parentId' : parentItem,
        };

        return new Promise((resolve, reject) => {
            chrome.contextMenus.create(menu, function(){
                if(engine.openall && engine.hidemenu){
                    _registerOnClick(id, function(info, tab){
                        _onOpenAll(engine, info, tab);
                    })
                }

                if(engine.openall && engine.hidemenu){
                    resolve()
                }
                else if(engine.openall){
                    _addOpenAllItem(engine, id).then(() => {
                        resolve(_addEngines(engine.engines, id))
                    })
                }else{
                    resolve(_addEngines(engine.engines, id))
                }
            })
        })
    }

    function _onEngineClick(engine, info, tab){
        var utils = new ContextMenuActionUtils(info, tab);
        var selection = info.selectionText || '';
        utils.openEngine(engine, selection)
        _clickCounterCallback(engine);
    }

    function _onOpenAll(engine, info, tab){
        var utils = new ContextMenuActionUtils(info, tab);
        var selection = info.selectionText || '';
        utils.openAllInSubmenu(engine, selection)
        _clickCounterCallback(engine);
    }


    function _addOpenAllItem(engine, parentItem){
        return new Promise((resolve, reject) => {
            let id = _nextItemId()
            chrome.contextMenus.create({
                'id': id,
                'title' :  i18n('contextmenu_open_all'),
                'contexts' :  ['selection'],
                'parentId' : parentItem,
            }, function(){
                _registerOnClick(id, function(info, tab){
                    _onOpenAll(engine, info, tab);
                })
                resolve(
                    _addSeparatorItem(engine, parentItem)
                )
            });

        })
    }


    // The "search by capturing an area" item (background/capture.js). It is
    // a separate top level item that is not shown for selected text, so the root
    // item above stays the only one there and Chrome does not group them.
    function _addCaptureItem(){
        return new Promise((resolve, reject) => {
            if(!_options.capture_context_menu){
                resolve()
                return
            }

            let contexts = ['page', 'frame', 'link', 'video', 'audio', 'editable']
            // Images get their own item, the overlay can still select another area from there
            if(!_options.capture_image_context_menu){
                contexts.push('image')
            }

            chrome.contextMenus.create({
                'id': _captureItem,
                'title' : i18n('contextmenu_capture'),
                'contexts' : contexts,
            }, function(){
                // The menu is recreated on every change, a leftover item is not an error
                void chrome.runtime.lastError;
                _registerOnClick(_captureItem, function(info, tab){
                    startCapture(tab)
                })
                resolve()
            })
        })
    }


    // "Search this image": starts the capture overlay with the image selected
    function _addImageItem(){
        return new Promise((resolve, reject) => {
            if(!_options.capture_image_context_menu){
                resolve()
                return
            }

            chrome.contextMenus.create({
                'id': _imageItem,
                'title' : i18n('contextmenu_image'),
                'contexts' : ['image'],
            }, function(){
                void chrome.runtime.lastError;
                _registerOnClick(_imageItem, function(info, tab){
                    startImageCapture(info, tab)
                })
                resolve()
            })
        })
    }


    function _removeRootItem(){
        return new Promise((resolve, reject) => {
            chrome.contextMenus.removeAll(() => {
                resolve()
            })
        })
    }

    function _createRootItem(){
        return new Promise((resolve, reject) => {
            _removeRootItem().then(() => {
                let contexts = ['selection'];
                if (_options.allow_engines_without_selection) {
                    contexts.push('page');
                }

                chrome.contextMenus.create({
                    'id': _rootItem,
                    'title' : i18n('contextmenu_root'),
                    'contexts' : contexts
                }, () => {
                    resolve()
                })
            })
        })
    }

    function _nextItemId(){
        return `${_idCounter++}`;
    }

    function _onClickItem(info, tab){
        let cb = _onClickCallbacks[info.menuItemId]
        if(cb){
            cb(info, tab)
        }
    }

    function _registerOnClick(id, callback){
        _onClickCallbacks[id] = callback
    }
}


