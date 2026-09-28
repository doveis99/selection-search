
const defaultStyleCSS = `
:host {
  all: initial!important;
}

.common li, .common span, .common a, .common input, .common img, .common h4,
.popup, .engine-editor{
    direction: ltr;
	margin: 0;
	padding: 0;
	border: 0;
	outline: 0;
	font-size: 10pt;
	font-weight: normal;
	text-decoration: none;
	font-family: sans-serif;
	vertical-align: baseline;
	background: transparent;
	color: #202020;
	text-align: left;
	line-height: normal;
	white-space: normal;
	-webkit-box-shadow: none;
	-webkit-border-radius:0;
	text-shadow: none;
	float: none;
	overflow: visible;
}
.common li, .common p, .common div, .common ul, .common h4{
	display: block;
}
.common h4{
	font-weight: bold;
}
.common ul{
	list-style-type: none;
}
.common span, .common img{
	display: inline;
}
.common input{
	display: inline-block;
	white-space: pre;
}
.common a:after, .common a[href^="http"]:after {
  content: '';
}
.engine-editor{

    z-index: 2147483647;
	padding: 0.5em;
	width: 35em;
	font-size: 9pt;
	background: #EDEDED;
	border: 3px solid #878787;
	-webkit-border-radius: 5px;
	-webkit-box-shadow: 0px 0px 8px #B0B0B0;
}
.engine-editor input[type='text']{
	width: 100%;
	margin-bottom: 0.5em;
	padding: 0.1em 0;
	display: block;
	border: 1px solid #A0A0A0;
	background: #fff;
	-webkit-border-radius: 2px;
}
.engine-editor input[type='button']{
	width: auto;
	display: inline-block;
	margin-top: 0.5em;
	margin-right: 0.5em;
	padding: 0.2em 0.4em;
	text-align: center;
	background: -webkit-gradient(linear, left top, left bottom, from(#F5F5F5), to(#E0E0E0));
	border: 1px solid #A0A0A0;
	-webkit-border-radius: 2px;
}
.engine-editor input[type='button']:hover{
	border: 1px solid #7C7C7C;
}
.engine-editor input[type='button']:active{
	background: -webkit-gradient(linear, left top, left bottom, from(#E0E0E0), to(#F5F5F5));
}
.engine-editor input[type='button']:disabled{
	color: #AAAAAA;
	background: -webkit-gradient(linear, left top, left bottom, from(#E7E7E7), to(#D3D3D3));
}
.engine-editor h4{
	margin: 0;
	height: 1.5em;
	font-size: 1.1em;
	padding-bottom: 0.3em;
	margin-bottom: 0.5em;
	border-bottom: 1px solid #CECECE;
}
.engine-editor input.close{
	float: right;
	margin: 0;
	height: 1.4em;
	width: 1.4em;
	padding-bottom: 0.3em;
	vertical-align: middle;
}
.engine-editor span.title{
	float: left;
	font-weight: bold;
	line-height: 1.5em;
}


/*
 * The colors are defined as variables so that custom styles can change the
 * colors without overriding every rule, e.g. for dark mode. The border, hover
 * and input colors are translucent so they also work with custom backgrounds.
 */
.popup, .button{
 --ss-bg: #ffffff;
 --ss-text: #1f2328;
 --ss-border: rgba(127, 127, 127, 0.28);
 --ss-hover: rgba(26, 102, 210, 0.12);
 --ss-input-bg: rgba(127, 127, 127, 0.1);
 --ss-accent: #1a66d2;
 --ss-shadow: 0 8px 24px rgba(15, 23, 42, 0.16), 0 1px 3px rgba(15, 23, 42, 0.08);
 --ss-font: -apple-system, BlinkMacSystemFont, "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif;
}
.popup{
 width: 13em;
 position: absolute;
 background: var(--ss-bg);
 border: 1px solid var(--ss-border);
 border-radius: 10px;
 padding: 4px;
 font-size: 13px;
 margin: 0;
 list-style-type: none;
 box-shadow: var(--ss-shadow);
 display: block;
 font-family: var(--ss-font);
 z-index: 2147483647;
}
.popup li{
 margin: 0;
 padding: 0;
 text-align: left;
 color: var(--ss-text);
 display: block;
 font-family: var(--ss-font);
 font-size: 13px;
}
.popup input{
 box-sizing: border-box;
 width: 100%;
 padding: 5px 8px;
 border: 1px solid transparent;
 border-radius: 6px;
 background: var(--ss-input-bg);
 color: var(--ss-text);
 font-family: var(--ss-font);
 font-size: 12px;
 line-height: 1.4;
}
.popup input:focus{
 border-color: var(--ss-accent);
}
.popup img{
 flex: none;
 width: 16px;
 height: 16px;
 vertical-align: middle;
 border: none;
 margin: 0 8px 0 0;
 display: inline;
}
.popup.mainmenu > li:first-child {
 overflow: hidden;
 text-overflow: ellipsis;
 white-space: nowrap;
 padding: 2px 2px 6px;
 margin-bottom: 4px;
 border-bottom: 1px solid var(--ss-border);
}
.popup a{
 display: flex;
 align-items: center;
 margin: 1px 0;
 padding: 5px 8px;
 border-radius: 6px;
 text-decoration: none;
 color: var(--ss-text);
 font-family: var(--ss-font);
 font-size: 13px;
 line-height: 1.4;
 cursor: pointer;
}
.popup a:hover, .popup a.active{
 background: var(--ss-hover);
}
.popup .engine-name{
 display: inline-block;
 flex: 1 1 auto;
 min-width: 0;
 max-width: calc(100% - 24px);
 overflow: hidden;
 text-overflow: ellipsis;
 white-space: nowrap;
 vertical-align: middle;
 color: inherit;
 font-family: inherit;
 font-size: inherit;
 line-height: inherit;
}
.button {
 position: absolute;
 width: 20px;
 height: 20px;
 background-color: var(--ss-bg);
 background-repeat: no-repeat;
 background-position: center center;
 background-size: 16px 16px;
 border: 1px solid var(--ss-border);
 border-radius: 6px;
 box-shadow: 0 2px 8px rgba(15, 23, 42, 0.18);
 font-family: var(--ss-font);
 cursor: pointer;
 z-index: 2147483647;
}
.button:hover{
 border-color: var(--ss-accent);
}
.popup .engine-separator{
 height: 1px;
 margin: 4px 6px;
 background: var(--ss-border);
}
.popup.hidden{
	display: none;
}
`
