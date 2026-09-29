

var ACTIVATORS = {
	'disabled' : i18n('activator_disabled'),
	'click' : i18n('activator_click'),
	'auto' :  i18n('activator_auto'),
// 	'contextmenu' : 'Context Menu',
	'k_and_m' : i18n('activator_k_and_m'),
	'combo' :  i18n('activator_combo'),
}

var _G_folder_id_count = 0;
var _G_engine_id_count = 0;

function emptyEngine(){
	return {name:'', url:'', icon_url:''}
}

function emptySeparator(){
	return {is_separator:true}
}

function emptySubmenu(){
	return {name:i18n('new_submenu_name'), url:'', icon_url:'', is_submenu:true}
}

function addNewEngine(en, level, add_at_position){


    var template_data = {en:en, id:++_G_engine_id_count};

	if(en.is_separator){
		_addSeparator(template_data, level, add_at_position);
        return;
	}

    if(en.is_submenu)
        template_data.folder_id = ++_G_folder_id_count;


    var el = $(render.searchengine(template_data));
	applyI18n(el[0]);

	Reorder.makeMovable(el);

	el.data('level', level);

    _addEngineOptions(en, el);

	if(add_at_position !== undefined){
		$('#engines tr').eq(add_at_position).after(el);
	} else {
		$('#engines').append(el);
	}

	if(!en.is_submenu){
		Reorder.initElements(el);
		return;
	}

	var engines = en.engines || [];

	for(var i=0,e=engines.length; i<e; ++i){
		addNewEngine(engines[i], level+1);
	}

    var end = $(render.folder_end(template_data)).data('level', level+1);

	Reorder.initElements(el);
	Reorder.initElements(end);

	if(add_at_position !== undefined){
		$('#engines tr').eq(add_at_position + 1).after(end);
	} else {
		$('#engines').append(end);
	}

}


function _addSeparator(template_data, level, add_at_position){

    var el = $(render.separator(template_data));
	applyI18n(el[0]);

	el.data('level', level);

	_addEngineOptions(template_data.en, el);

	Reorder.initElements(el);
	Reorder.makeMovable(el);

	if(add_at_position !== undefined){
		$('#engines tr').eq(add_at_position).after(el);
	}
	else {
		$('#engines').append(el);
	}
}

function _addEngineOptions(en, el){


	var opts = el.find('.engine-options-popup');
	var add_popup = el.find('.add-inline-popup');

	opts.on('click', function(e){
		e.stopPropagation();
	})

    opts.find('.close-popup').click(function(){
		opts.fadeOut(100);
        return false;
    });


	el.find('.engine-opts-link').click(function(){

		$('.dropdown-popup').not(opts).hide();

		var x = $(this).offset().left - opts.outerWidth()-4;
		var y = $(this).offset().top;
		opts.css({top:y+'px', left:x+'px'});
		opts.fadeToggle(100);
		return false;
	});

	el.find('.add-inline').click(function(){

		$('.dropdown-popup').not(add_popup).hide();

		var x = $(this).offset().left - add_popup.outerWidth()-4;
		var y = $(this).offset().top - add_popup.outerHeight() / 2 + 12;
		add_popup.css({top:y+'px', left:x+'px'});
		add_popup.fadeToggle(100);
		return false;
	});

	add_popup.find('button').click(function(){

		let index = el.index()
		let level = el.data('level')

		if($(this).hasClass("add-before")){
			index--
		} else {
			if (el.hasClass('menu-folder')){
				// When adding after a folder we increment the level to add the item
				// into the folder.
				level++;
			}
		}


		if($(this).hasClass('add-inline-engine')){
			addNewEngine(emptyEngine(), level, index)
		}
		else if($(this).hasClass('add-inline-separator')){
			addNewEngine(emptySeparator(), level, index)
		}
		else if($(this).hasClass('add-inline-submenu')){
			addNewEngine(emptySubmenu(), level, index)
		}
		return false;
	});



	el.find('.delete').click(function(){

		if(el.hasClass('menu-folder')){
			var elms = el.nextUntil('#end-'+el.attr('id'));
			$('#end-'+el.attr('id')).remove();
			elms.each(function(){$(this).data('level', $(this).data('level')-1);});
			Reorder.initElements(elms);
		}
		el.remove();
		return false;
	});


    opts.find('.openall').change(function(){
        opts.find('.hide_menu_wrap').toggle($(this).is(':checked'));
    }).attr('checked', Boolean(en.openall)).change();

    opts.find('.openall_aux').attr('checked', Boolean(en.openall_aux));

    opts.find('.background_global').click(function(){
        opts.find('.background_tab').attr('disabled', $(this).is(":checked"));
    });

	opts.find('.hide_in_popup').attr('checked', !Boolean(en.hide_in_popup));
    opts.find('.hide_in_ctx').attr('checked', !Boolean(en.hide_in_ctx));
    opts.find('.hide_in_toolbar').attr('checked', !Boolean(en.hide_in_toolbar));
    opts.find('.nosync').attr('checked', !Boolean(en.nosync));
	opts.find('.post').attr('checked', Boolean(en.post));
    opts.find('.hide_on_click').attr('checked', Boolean(en.hide_on_click));
    opts.find('.open_in_incognito').attr('checked', Boolean(en.open_in_incognito));
    opts.find('.open_in_window').attr('checked', Boolean(en.open_in_window));
    opts.find('.open_in_popup').attr('checked', Boolean(en.open_in_popup));

	if(en.background_tab === undefined){
		opts.find('.background_global').attr('checked', true);
		opts.find('.background_tab').attr('disabled', true);
	}else{
		opts.find('.background_global').attr('checked', false);
		opts.find('.background_tab').attr('checked', en.background_tab);
	}


    if(!$("#opt-newtab").is(':checked')){
        opts.find('.engine-opt-background_tab').hide();
    }else{
        opts.find('.engine-opt-background_tab').show();
    }

    opts.find(".negate_newtab_option").attr('checked', Boolean(en.negate_newtab_option));

    // folders
    opts.find('.hidemenu').attr('checked', Boolean(en.hidemenu));

	if(!en.is_separator){
		var hotkeys = HotKeys.createHotkeyInputForElement(opts.find('.hotkey-definition-input'), en.hotkey || []);
		opts.find('.clear-hotkey').on('click', function(){
			hotkeys.clearCombo();
			return false;
		});
	}
}



function loadPopupPreview(){


    var dom = document.documentElement;
    var style = new Style(dom);

    var preview_container = document.getElementById("preview");

    var preview_button = document.getElementById("preview-button");

	chrome.runtime.sendMessage({action:"getContentScriptData"}, function(response){

        style.setDefaultStyle(response.default_style);

        if(response.extra_style)
            style.setCustomStyle(response.extra_style);


        var popup = new Popup(response.options, style);

        if(response.options.circular_menu){
            popup.setModifier(new CircularPopup(popup, style, response.options));
        }


        popup.showForPreview();
        preview_container.appendChild(popup.getNode());
        popup.setSearchEngines(response.engines.slice(0, 5));


        var button = new Button(popup, style);
        button.showForPreview();
        preview_button.appendChild(button.getNode());


        chrome.runtime.sendMessage({action:"getPopupIcons"}, function(response){

            popup.setIcons(response.icons);

        });

	});
    return style;

}


function initOptionsPage(){

	$("#chrome-shortcut").on('click', function(){
		chrome.tabs.create({'url': "chrome://extensions/shortcuts" } )
		return false;
	})

	// var popup = new PopUp();


	// The style system has changed.
	// Check if the user has changed the style. If it hasn't we can clear the stored style.
	var stored_style = Storage.getStyle('');
	if (stored_style == $('#old-default-style').val())
		Storage.setStyle('');

	var CURRENT_STYLE = '';
	var hotkey_editor = null;


    var styling = loadPopupPreview();



	chrome.runtime.sendMessage({action:"getOptions"}, function(response){

		// popup.setOptions(response.options);

		if(response.extra_style){
			CURRENT_STYLE=response.extra_style;
			$('#select_theme').prepend($('<option selected="selected" value="current_style"></option>').text(i18n('current_style')));
		}


		$("input[name='button']").filter("[value="+response.options.button+"]").attr('checked', true);

		$("input[name='newtab']").attr('checked', response.options.newtab);
		$("input[name='background_tab']").attr('checked', response.options.background_tab);

		$("input[name='show_in_inputs']").attr('checked', response.options.show_in_inputs);
		$("input[name='hide-on-click']").attr('checked', response.options.hide_on_click);
		$("input[name='disable-effects']").attr('checked', response.options.disable_effects);
		$("input[name='show-tooltips']").attr('checked', response.options.show_tooltips);

		$("#select_activator option[value='"+response.options.activator+"']").attr('selected', true);
		$("#select_activator").change();


		$('input[name=remove_icons][value='+response.options.remove_icons+']').attr('checked', true).change();


		hotkey_editor = HotKeys.createHotkeyInput('#k_and_m_keys', response.options.k_and_m_combo.slice(0, -1));
		$("#k_and_m_button").val(response.options.k_and_m_combo[response.options.k_and_m_combo.length-1]);



		$("#contextmenu_option").attr('checked', response.options.context_menu === 'enabled');

		$("#toolbar_popup_option").attr('checked', response.options.toolbar_popup === 'enabled').change();
		$("#opt-toolbar-popup-icons-only").attr('checked', response.options.toolbar_popup_style === 'icons-only');
		$("#opt-toolbar-popup-hotkeys").attr('checked', response.options.toolbar_popup_hotkeys);
		$("#opt-toolbar-popup-suggestions").attr('checked', response.options.toolbar_popup_suggestions);

		$("#opt-separate-engines").attr('checked', response.options.separate_menus).change();

		$("#opt-disable-extractform").attr('checked', response.options.disable_formextractor);

		$("#opt-open-on-dblclick").attr('checked', response.options.open_on_dblclick).change();
		$("#opt-dblclick-in-inputs").attr('checked', response.options.dblclick_in_inputs);
		$("#opt-open-new-tab-last").attr('checked', response.options.open_new_tab_last);

		$("#auto_popup_relative_to_mouse").attr('checked', response.options.auto_popup_relative_to_mouse);
		$("#auto_popup_show_menu_directly").attr('checked', response.options.auto_popup_show_menu_directly).change();
		$("#auto_popup_in_inputs").attr('checked', response.options.auto_popup_in_inputs);

		$("#opt-sync-engines").attr('checked', response.sync_options.sync_engines);
		$("#opt-sync-settings").attr('checked', response.sync_options.sync_settings);
		$("#opt-sync-style").attr('checked', response.sync_options.sync_style);

        $("#circular_menu").attr('checked', response.options.circular_menu);


		$("#opt-sort-by-click").attr('checked', response.options.sort_by_click);

		$("#opt-selection-allow-newline").attr('checked', response.options.selection_allow_newline);
		$("#opt-selection-length-limit").val(response.options.selection_length_limit).trigger('input');
		$("#opt-auto-hide-delay").val(response.options.auto_hide_delay);
		$("#opt-auto-open-delay").val(response.options.auto_open_delay);
		$("#opt-hide-on-scroll").attr('checked', response.options.hide_on_scroll);

		$("#opt-use-whitelist").attr('checked', response.options.use_whitelist);
		$("#blacklist-definitions").val(response.blacklist.join('\n'));
		$("#opt-use-blacklist-for-hotkeys").attr('checked', response.options.use_blacklist_for_hotkeys);
		$("#opt-allow-engines-without-selection").attr('checked', response.options.allow_engines_without_selection);

		$("#opt-ai-chat-autosend").attr('checked', response.options.ai_chat_autosend).change();
		$("#opt-ai-chat-gemini-temp-chat").attr('checked', response.options.ai_chat_gemini_temp_chat);
		$("#opt-ai-chat-claude-incognito").attr('checked', response.options.ai_chat_claude_incognito);

		$("#toolbarStyle").val(response.toolbar_style);

        // set activator combo
        for(var i in response.options.activator_combo){
            var act = response.options.activator_combo[i];
            $("#combo_"+act).attr("checked", true);

        }
        _updateActivatorOptions();


        // Add search engines
		for (var i in response.searchEngines){
			var en = response.searchEngines[i];

			addNewEngine(en, 0);
		}

		$(document).on('click', function(){
			$('.dropdown-popup').hide();
		});

		$('#select_theme').change();

	});


	$('#search-icon').append('<img src="'+chrome.runtime.getURL('../img/icon16.png')+'" width="16px" height="16px" />');

	$('#new-engine').click(function(){
		addNewEngine(emptyEngine(), 0);
		return false;
	});

	$('#new-folder').click(function(){
		addNewEngine(emptySubmenu(), 0);
		return false;
	});

	$('#new-separator').click(function(){
		addNewEngine(emptySeparator(), 0);
		return false;
	});


	$("#opt-newtab").click(function(){

		if(!$(this).is(':checked')){
			$('.engine-opt-background_tab').hide();
		}else{
			$('.engine-opt-background_tab').show();
		}

	});

	$("#opt-selection-length-limit").on('input', function(){
		if($(this).val() <= 0){
			$(this).val("");
		}
	})

    $("#circular_menu").change(function(){

        var ok = confirm(i18n('confirm_circular_menu'));

        if(!ok){
            $(this).attr('checked', !$(this).is(":checked"));
            return;
        }

        if($(this).is(":checked")){

            var css = $('#circular-style').val();
            $("#style").val(css);
            styling.setCustomStyle(css);

        }else{
            $("#style").val('');
            styling.setCustomStyle('');
        }

        $("#save").click();
        location.reload();
    });



	function saveCurrentSettingsToStore(dataStore){
		var folder_stack = [{engines:[]}]; // folder stack with the root item

		$('#engines tr:gt(0)').each(function(index){

			var en = {};

			$(this).find('input').each(function(){
				if ($(this).attr('type') == 'checkbox')
					en[$(this).attr('class')] = $(this).is(':checked');
				else
					en[$(this).attr('class')] = $(this).val();
			});

			if(en.icon_url === '')
				delete en.icon_url;
			if(!en.post)
				delete en.post;

			if(!en.hide_on_click)
				delete en.hide_on_click;

			// The checkboxes for the hide_* options shows the oposite state of the hide option, so
			// if the checkbox is checked it means that the engine should not be hidden.
			if(en.hide_in_popup)
				delete en.hide_in_popup;
			else
				en.hide_in_popup = true;

			if(en.hide_in_ctx)
				delete en.hide_in_ctx;
			else
				en.hide_in_ctx = true;

			if(en.hide_in_toolbar)
				delete en.hide_in_toolbar;
			else
				en.hide_in_toolbar = true;

			if(en.nosync)
				delete en.nosync;
			else
				en.nosync = true;

			if(!en.open_in_incognito)
				delete en.open_in_incognito;

			if(!en.open_in_window){
				delete en.open_in_window;
			}

			if(!en.open_in_popup){
				delete en.open_in_popup;
			}

			if(en.background_global !== undefined){
				if(en.background_global)
					delete en.background_tab;
				delete en.background_global;
			}

			if(!en.negate_newtab_option){
				delete en.negate_newtab_option;
			}

            delete en['hotkey-definition-input'];

            en.hotkey = $(this).find('.hotkey-definition-input').data('hotkey');
			if(en.hotkey != undefined && en.hotkey.length === 0){
				delete en.hotkey;
			}

			if($(this).hasClass('menu-folder')){

				if(!en.openall){
					delete en.openall;
					delete en.hidemenu;
					delete en.hide_on_click;
					delete en.openall_aux;
				}
				else if(!en.hidemenu){
					delete en.hidemenu;
				}

				en.is_submenu = true;
				en.engines = [];

				folder_stack[folder_stack.length-1].engines.push(en);
				folder_stack.push(en);

			}
			else if($(this).hasClass('menu-separator')){
				en.is_separator = true;

				delete en.hotkey;

				folder_stack[folder_stack.length-1].engines.push(en);
			}
			else if($(this).hasClass('menu-folder-end')){
				folder_stack.pop()
// 				current_folder = null;
			}
			else if(en.name && en.url){

				folder_stack[folder_stack.length-1].engines.push(en);
			}
		});

		// When we get here only the root item should be left
		var new_engines = folder_stack[0].engines;



		var k_and_m_combo = hotkey_editor.getCombo();
		k_and_m_combo.push(parseInt($("#k_and_m_button").val(), 10));


		dataStore.setSearchEngines(new_engines);

		dataStore.setStyle(jQuery.trim($('#style').val()));
		dataStore.setToolbarStyle(jQuery.trim($('#toolbarStyle').val()));


        var act_combo = $('input[name=activator_combo]:checked').map(function() {
                return $(this).val();
        }).get();


		var selection_limit = $("#opt-selection-length-limit").val();
		if(selection_limit === ""){
			selection_limit = -1;
		}

		var auto_hide_delay = parseInt($("#opt-auto-hide-delay").val());
		if(isNaN(auto_hide_delay) || auto_hide_delay < 0){
			auto_hide_delay = 0;
		}

		var auto_open_delay = parseInt($("#opt-auto-open-delay").val());
		if(isNaN(auto_open_delay) || auto_open_delay < 0){
			auto_open_delay = 0;
		}

		dataStore.setOptions({
			button: parseInt($("input[name='button']:checked").val(), 10),
			newtab: $("input[name='newtab']").is(':checked'),
			background_tab: $("input[name='background_tab']").is(':checked'),
			activator: $('#select_activator option:selected').first().attr('value'),
			remove_icons:$('input[name=remove_icons]:checked').val(),
			show_in_inputs: $('input[name=show_in_inputs]').is(':checked'),
			k_and_m_combo:k_and_m_combo,
			context_menu: $('#contextmenu_option').is(':checked') ? 'enabled' : 'disabled',
			toolbar_popup: $('#toolbar_popup_option').is(':checked') ? 'enabled' : 'disabled',
			toolbar_popup_style: $('#opt-toolbar-popup-icons-only').is(':checked') ? 'icons-only' : 'default',
			toolbar_popup_hotkeys: $('#opt-toolbar-popup-hotkeys').is(':checked'),
			toolbar_popup_suggestions: $('#opt-toolbar-popup-suggestions').is(':checked'),
			separate_menus: $('#opt-separate-engines').is(':checked'),
			hide_on_click: $("input[name='hide-on-click']").is(':checked'),
			disable_formextractor: $('#opt-disable-extractform').is(':checked'),
			open_on_dblclick: $('#opt-open-on-dblclick').is(':checked'),
			dblclick_in_inputs: $('#opt-dblclick-in-inputs').is(':checked'),
			open_new_tab_last: $('#opt-open-new-tab-last').is(':checked'),
			disable_effects: $('#opt-disable-effects').is(':checked'),
			show_tooltips: $('#opt-show-tooltips').is(':checked'),
			auto_popup_relative_to_mouse: $('#auto_popup_relative_to_mouse').is(':checked'),
			auto_popup_show_menu_directly: $('#auto_popup_show_menu_directly').is(':checked'),
			auto_popup_in_inputs: $("#auto_popup_in_inputs").is(':checked'),
            activator_combo: act_combo,
			circular_menu: $('#circular_menu').is(':checked'),
			sort_by_click: $('#opt-sort-by-click').is(':checked'),
			selection_allow_newline: $('#opt-selection-allow-newline').is(':checked'),
			use_whitelist: $('#opt-use-whitelist').is(':checked'),
			selection_length_limit: selection_limit,
			auto_hide_delay: auto_hide_delay,
			auto_open_delay: auto_open_delay,
			hide_on_scroll: $('#opt-hide-on-scroll').is(':checked'),
			use_blacklist_for_hotkeys: $('#opt-use-blacklist-for-hotkeys').is(':checked'),
			allow_engines_without_selection: $('#opt-allow-engines-without-selection').is(':checked'),
			ai_chat_autosend: $('#opt-ai-chat-autosend').is(':checked'),
			ai_chat_gemini_temp_chat: $('#opt-ai-chat-gemini-temp-chat').is(':checked'),
			ai_chat_claude_incognito: $('#opt-ai-chat-claude-incognito').is(':checked'),
		});


		dataStore.setSyncOptions({
			sync_engines: $('#opt-sync-engines').is(':checked'),
			sync_settings: $("#opt-sync-settings").is(':checked'),
			sync_style: $('#opt-sync-style').is(':checked'),
		});


        var blacklist = $('#blacklist-definitions').val().split('\n').map(function(value){
            return value.trim();
        }).filter(function(value){
            return value.length > 0;
        });

        dataStore.setBlacklistDefinitions(blacklist);

	}

	var _savedStatusTimeout = null;

	$('#save').click(function(){
		saveCurrentSettingsToStore(Storage);
		chrome.runtime.sendMessage({action:"storageUpdated"});
		$(document).trigger('settings-saved');

		// Briefly show that the settings were saved
		$('.save-restore-buttons').addClass('just-saved');
		clearTimeout(_savedStatusTimeout);
		_savedStatusTimeout = setTimeout(function(){
			$('.save-restore-buttons').removeClass('just-saved');
		}, 2500);
	});

	$('#cancel').click(function(){
		location.reload();
	})

	var urlEditor = initUrlEditor();

	// Ctrl+S / Cmd+S saves the settings, including a url being edited in the url editor
	$(document).on('keydown', function(e){
		if((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's'){
			e.preventDefault();
			if(urlEditor.isOpen())
				urlEditor.apply();
			$('#save').click();
		}
	});


	$('#restore').click(function(){

		if(confirm(i18n('confirm_restore'))){

			Storage.clear();
			location.reload();
		}
		return false;
	});

	$('#update-preview').click(function(e){

        styling.setCustomStyle($('#style').val());

		return false;
	});

	var theme_select = $('#select_theme');

    if(!Storage.getOptions().circular_menu){
        $('.theme_def').each(function(){
            // The theme names are translated using the id of the theme definition as key
            theme_select.append($('<option></option>').val($(this).attr('id')).text(i18n($(this).attr('id'))));
        });
    }

    theme_select.change(function(){

        var opt = $('#select_theme option:selected').first();

        var id = opt.attr('value');

        if(id == 'current_style'){
            $("#style").val(CURRENT_STYLE);
            styling.setCustomStyle(CURRENT_STYLE);
            return;
        }

        var css = $('textarea#' + id).val();

        $("#style").val(css);

        styling.setCustomStyle(css);

    });

	for (var act in ACTIVATORS){

		var name = ACTIVATORS[act];

		$('#select_activator').append('<option value="' + act + '">'+name+'</option>');
	}

	// Shows the options for the selected activator. When multiple activators are
	// used, the options for each of the checked activators are also shown.
	function _updateActivatorOptions(){

		var val = $('#select_activator option:selected').first().attr('value');
		var visible = [val];

		if(val == 'combo'){
			visible = visible.concat($('input[name=activator_combo]:checked').map(function(){
				return $(this).val();
			}).get());
		}

		$('.activator_options').each(function(){
			$(this).toggle(visible.indexOf(this.id.replace('activator_', '')) !== -1);
		});
	}

	$('#select_activator').change(_updateActivatorOptions);
	$('input[name=activator_combo]').change(_updateActivatorOptions);


	// Hide the option to position the button under the mouse if the option
	// to directly show the menu is enabled; otherwise, show the former
	// option.
	$('#auto_popup_show_menu_directly').change(function(){

		if($(this).is(':checked'))
			$("#auto_popup_relative_to_mouse_content").hide(100);
		else
			$("#auto_popup_relative_to_mouse_content").show(100);

	});



	$('#toolbar_popup_option').change(function(){

		$('#toolbar_popup_active').toggle($(this).is(':checked'));

	});



	$('#show_customize').click(function(){
		var hidden = $("#customize").is(":hidden");

		$('#customize').toggle();

		if (hidden){
			$('html, body').animate({
				scrollTop: $("#head-styling").offset().top
			}, 500);
		}

		return false;
	});


	$('#show_html').click(function(){
		$('#html').toggle();
		return false;
	});


	$('#show-blacklist-info').click(function(){
		$('.blacklist-info').slideToggle(200);
		return false;
	});


	$(document).on('focus', '.hotkey-definition-input', function(){
		var _input = $(this);
		var top = _input.offset().top - $("#hotkey_info").outerHeight() - 5;
		$("#hotkey_info").css({'top' : top+ 'px', 'left' : _input.offset().left + 'px'});
		$("#hotkey_info").slideToggle(100);
	});

	$(document).on('blur', '.hotkey-definition-input', function(){
		$("#hotkey_info").hide(100);
	});



	$('#opt-separate-engines').change(function(){

		$('#wrap-edit-separate-engines').toggle($(this).is(':checked'));

	});

	$('#opt-open-on-dblclick').change(function(){
		$('#opt-dblclick-in-inputs').attr('disabled', !$(this).is(':checked'));
	})

	$('#opt-ai-chat-autosend').change(function(){
		$('#opt-ai-chat-gemini-temp-chat, #opt-ai-chat-claude-incognito').attr('disabled', !$(this).is(':checked'));
	})

	function _load_export(){


		var to_export = {}

		if($('#export-search-engines').is(':checked'))
			to_export.searchEngines = Storage.getSearchEngines();
		if($('#export-style').is(':checked')){
			to_export.styleSheet =  Storage.getStyle();
			to_export.toolbarStyleSheet =  Storage.getToolbarStyle();
		}
		if($('#export-options').is(':checked'))
			to_export.options =  Storage.getOptions();

		if(!jQuery.isEmptyObject(to_export)){

			if(Storage.getVersion() !== undefined){
				to_export.VERSION = Storage.getVersion();
			}

			to_export = JSON.stringify(to_export);

// 			if($('#encode-output').is(':checked'))

			try{
				to_export = btoa(to_export);
			}catch(e){
				to_export = '1e:' + btoa(encodeURI(to_export));
			}

		}else
			to_export = '';

		$('#export-settings textarea').val(to_export);

	}

	var _import_decoders = {
		'1e' : function(v){return JSON.parse(decodeURI(atob(v)))},
		'1' : function(v){return JSON.parse(atob(v))}
	}


	function _do_import(){


		var to_import = $('#import-settings textarea').val();

		if(to_import.length == 0){
			alert(i18n('import_no_data'));
			return;
		}

		try{

			var parts = to_import.split(':');

			var decoder = '1';

			if(parts.length == 2){
				to_import = parts[1];
				decoder = parts[0];
			}

			if(decoder in _import_decoders)
				to_import = _import_decoders[decoder](to_import);
			else
				to_import = null;

		}catch(err){
			to_import = null;
		}
		if(!to_import || jQuery.isEmptyObject(to_import)){
			alert(i18n('import_failed'));
			return;
		}


		if( !$('#import-search-engines').is(':checked') &&
			!$('#import-style').is(':checked') &&
			!$('#import-options').is(':checked')){
			alert(i18n('import_nothing_selected'));
			return;
		}

		var msg = [];

		if($('#import-search-engines').is(':checked')){

			if(!to_import.hasOwnProperty('searchEngines'))
				msg.push(i18n('import_engines_missing'));
			else{

				msg.push(i18n('import_engines_ok'));

				if($('#import-replace-engines').is(':checked')){
					Storage.setSearchEngines(to_import.searchEngines);
				}else{
					var prev_engines = Storage.getSearchEngines();
					Storage.setSearchEngines(prev_engines.concat(to_import.searchEngines));
				}
			}
		}

		if($('#import-style').is(':checked')){

			if(!to_import.hasOwnProperty('styleSheet') && !to_import.hasOwnProperty("toolbarStyleSheet"))
				msg.push(i18n('import_style_missing'));
			else{
				msg.push(i18n('import_style_ok'));
				if(to_import.hasOwnProperty('styleSheet')){
					Storage.setStyle(to_import.styleSheet);
				}
				if(to_import.hasOwnProperty('toolbarStyleSheet')){
					Storage.setToolbarStyle(to_import.toolbarStyleSheet);
				}
			}

		}

		if($('#import-options').is(':checked')){

			if(!to_import.hasOwnProperty('options'))
				msg.push(i18n('import_options_missing'));
			else{
				msg.push(i18n('import_options_ok'));
				Storage.setOptions(to_import.options);
			}
		}

		alert(i18n('import_done') + '\n\n' + msg.join('\n'));

		chrome.runtime.sendMessage({action:"storageUpdated"});

		location.reload();

	}


	// The export only contains saved settings, so it is reloaded when the
	// backup tab is shown and when the settings are saved.
	_load_export();
	$(document).on('tab-shown', function(e, tab){
		if(tab == 'backup')
			_load_export();
	});
	$(document).on('settings-saved', _load_export);

	$('#export-settings input').change(function(){
		_load_export();
	});

	$('#export-settings textarea').click(function(){
		this.select();
	});

	$('#export-copy').click(function(){
		var button = $(this);
		navigator.clipboard.writeText($('#export-settings textarea').val()).then(function(){
			button.text(i18n('export_copied'));
			setTimeout(function(){ button.text(i18n('export_copy')); }, 2000);
		});
		return false;
	});

	$('#import-search-engines').change(function(){

		if($(this).is(':checked'))
			$('#import-replace-engines-opt').slideDown(100);
		else
			$('#import-replace-engines-opt').slideUp(100);

	});


	$('#import-submit').click(function(){

		var replace_engines = $('#import-search-engines').is(':checked') && $('#import-replace-engines').is(':checked');
		var msg = i18n(replace_engines ? 'confirm_import_replace_engines' : 'confirm_import');

		if(confirm(msg))
			_do_import();

	});



	$('#show-more-variables').click(function(){

        // Change the link text to "Hide" when the variables is shows.
		if($(this).data('old-text')){
			$(this).text($(this).data('old-text')).removeData('old-text');
		}else{
			$(this).data('old-text', $(this).text()).text(i18n('hide_variables'));
		}


		$('#more-variables').slideToggle();

		return false;
	});


	$('#show-advanced-toolbar-opts').click(function(){

		$('#toolbar-advanced-options').slideToggle();
		return false;
	});



	// Detect changes in settings and highlight the save bar if changes are detected
	setTimeout(function(){

		function checkForChanges(){
			var tmpStore = newTempStorageDuplicate();
			saveCurrentSettingsToStore(tmpStore);
			if (tmpStore.hasChanges(Storage)) {
				$('.save-restore-buttons').addClass('changed');
			} else {
				$('.save-restore-buttons').removeClass('changed');
			}
		}

		var _changeDetectTimeout = null;

		function detectChanges(){
			if(_changeDetectTimeout != null){
				clearTimeout(_changeDetectTimeout);
			}
			_changeDetectTimeout = setTimeout(function(){
				checkForChanges();
				_changeDetectTimeout = null;
			}, 250);
		}

		$(document).on('settings-saved', detectChanges);
		$(document).on('change', 'input,select,textarea', detectChanges);
		$(document).on('input', 'input,textarea', detectChanges);
		$(document).on('mouseup', '#new-engine, #new-separator, #new-folder, .delete, .drag-target, .clear-hotkey, .add-inline-button', detectChanges);

	}, 500);

}


// Dialog for editing long search urls, e.g. urls containing AI prompts.
// Newlines in the editor are stored as %0A in the url.
function initUrlEditor(){

	var dialog = document.getElementById('url-editor');
	var text = $('#url-editor-text');
	var sample = $('#url-editor-sample');
	var utils = new BaseActionUtils();
	var target = null;

	function editorValue(){
		return text.val().trim().replace(/\r?\n/g, '%0A');
	}

	function updatePreview(){
		var url = utils.replaceSelection(editorValue(), sample.val());
		var result = $('#url-editor-result').text(url);

		// Only allow opening real web urls from the options page
		if(/^https?:\/\//i.test(url))
			result.attr('href', url);
		else
			result.removeAttr('href');
	}

	function apply(){
		if(target === null)
			return;
		target.val(editorValue()).trigger('input').trigger('change');
		dialog.close();
	}

	$(document).on('click', '.url-expand', function(){
		target = $(this).closest('td').find('input.url');

		$('#url-editor-engine').text($(this).closest('tr').find('input.name').val());
		text.val(target.val().replace(/%0A/g, '\n'));
		if(!sample.val())
			sample.val(i18n('url_editor_sample_default'));

		updatePreview();
		dialog.showModal();
		text.focus();
		return false;
	});

	text.on('input', updatePreview);
	sample.on('input', updatePreview);

	$('#url-editor .chip').click(function(){
		var el = text[0];
		el.setRangeText($(this).attr('data-insert'), el.selectionStart, el.selectionEnd, 'end');
		el.focus();
		updatePreview();
	});

	text.on('keydown', function(e){
		if((e.ctrlKey || e.metaKey) && e.key === 'Enter'){
			e.preventDefault();
			apply();
		}
	});

	$('#url-editor-apply').click(apply);
	$('#url-editor-cancel').click(function(){
		dialog.close();
	});
	dialog.addEventListener('close', function(){
		target = null;
	});

	return {
		isOpen: function(){ return dialog.open; },
		apply: apply,
	};
}


// The options page is split into tabs. The active tab is stored in the url
// hash, so it is kept when the page is reloaded.
function initTabs(){

	var tabs = $('#nav a').map(function(){ return $(this).data('tab'); }).get();

	function showTab(){
		var tab = location.hash.replace('#tab-', '');
		if(tabs.indexOf(tab) === -1)
			tab = tabs[0];

		$('#nav a').removeClass('active').filter('[data-tab="' + tab + '"]').addClass('active');
		$('.panel').removeClass('active');
		$('#panel-' + tab).addClass('active');
		$('.dropdown-popup, #hotkey_info').hide();
		window.scrollTo(0, 0);

		$(document).trigger('tab-shown', [tab]);
	}

	$(window).on('hashchange', showTab);
	showTab();
}


$(document).ready(function(){
	applyI18n(document);
	document.title = i18n('options_title');
	$('#ext-version').text('v' + chrome.runtime.getManifest().version);
	initTabs();

	storageLocalSyncInit(Storage).then(values => {
		initOptionsPage();
	});
});
