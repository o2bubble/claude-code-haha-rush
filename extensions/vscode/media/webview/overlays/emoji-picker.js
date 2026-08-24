/* ═══════════════════════════════════════════════════
   EMOJI PICKER — 6-column emoji grid with category tabs
   Design: vs-code-agent-dark.html — .emoji-grid
   Spec: design-spec.html §4.2 #10
   ═══════════════════════════════════════════════════ */

var EmojiPicker = (function () {

  var overlayEl = null;
  var onInsert = null;
  var activeCategory = 0;
  var activeEmoji = 0;

  var docClickBound = null;
  var docEscapeBound = null;

  var CATEGORIES = [
    {
      name: 'Smileys',
      emojis: [
        '\u{1F600}', '\u{1F601}', '\u{1F602}', '\u{1F603}', '\u{1F604}', '\u{1F605}',
        '\u{1F606}', '\u{1F607}', '\u{1F608}', '\u{1F609}', '\u{1F60A}', '\u{1F60B}',
        '\u{1F60C}', '\u{1F60D}', '\u{1F60E}', '\u{1F60F}', '\u{1F610}', '\u{1F611}',
        '\u{1F612}', '\u{1F613}', '\u{1F614}', '\u{1F615}', '\u{1F616}', '\u{1F617}',
        '\u{1F618}', '\u{1F619}', '\u{1F61A}', '\u{1F61B}', '\u{1F61C}', '\u{1F61D}',
        '\u{1F61E}', '\u{1F61F}', '\u{1F620}', '\u{1F621}', '\u{1F622}', '\u{1F623}',
        '\u{1F624}', '\u{1F625}', '\u{1F628}', '\u{1F629}', '\u{1F62A}', '\u{1F62B}',
        '\u{1F62C}', '\u{1F62D}', '\u{1F62E}', '\u{1F62F}', '\u{1F630}', '\u{1F631}',
        '\u{1F632}', '\u{1F633}', '\u{1F634}', '\u{1F635}', '\u{1F636}', '\u{1F637}',
        '\u{1F970}', '\u{1F971}', '\u{1F972}', '\u{1F973}', '\u{1F974}', '\u{1F975}',
        '\u{1F976}', '\u{1F978}', '\u{1F979}', '\u{1F97A}', '\u{1F928}', '\u{1F929}',
        '\u{1F92A}', '\u{1F92B}', '\u{1F92C}', '\u{1F92D}', '\u{1F92E}', '\u{1F92F}',
        '\u{1F920}', '\u{1F921}', '\u{1F924}', '\u{1F925}',
      ]
    },
    {
      name: 'Gestures',
      emojis: [
        '\u{1F44D}', '\u{1F44E}', '\u{1F44C}', '\u{1F448}', '\u{1F449}', '\u{1F446}',
        '\u{1F447}', '\u{1F44A}', '\u{1F44B}', '\u{1F44F}', '\u{1F450}', '\u{1F64C}',
        '\u{1F64F}', '\u{1F91D}', '\u{1F91E}', '\u{1F91F}', '\u{1F918}', '\u{1F919}',
        '\u{1F91A}', '\u{1F91B}', '\u{1F91C}', '\u{1F4AA}', '\u{1F590}', '\u{1F595}',
        '\u{1F596}', '\u{270C}\uFE0F', '\u{1F44C}', '\u{1F90C}', '\u{1F90F}', '\u{1F485}',
        '\u{1F4AA}', '\u{1F9BE}', '\u{1F9BF}', '\u{1F9B5}', '\u{1F9B6}',
        '\u{261D}\uFE0F', '\u{270A}', '\u{270B}', '\u{1F44A}',
      ]
    },
    {
      name: 'Hearts',
      emojis: [
        '\u2764\uFE0F', '\u{1F494}', '\u{1F495}', '\u{1F496}', '\u{1F497}',
        '\u{1F498}', '\u{1F499}', '\u{1F49A}', '\u{1F49B}', '\u{1F49C}',
        '\u{1F49D}', '\u{1F49E}', '\u{1F49F}', '\u{1F48C}', '\u{1F48F}',
        '\u{1F491}', '\u{1F48B}', '\u{1F90D}', '\u{1F90E}', '\u{1F9E1}',
        '\u{1F5A4}', '\u{1F48C}', '\u{1F48C}', '\u{1F48D}', '\u{1F48E}',
        '\u{1F492}', '\u{1F43B}\u200D\u2744\uFE0F',
      ]
    },
    {
      name: 'Nature',
      emojis: [
        '\u{1F525}', '\u2728', '\u{1F31F}', '\u{1F308}', '\u2600\uFE0F',
        '\u{1F31E}', '\u{1F31D}', '\u{1F31A}', '\u{1F319}', '\u{1F318}',
        '\u{1F311}', '\u{1F312}', '\u{1F313}', '\u{1F314}', '\u{1F315}',
        '\u{1F316}', '\u{1F317}', '\u{1F320}', '\u{1F32E}', '\u{1F32F}',
        '\u{1F330}', '\u{1F331}', '\u{1F332}', '\u{1F333}', '\u{1F334}',
        '\u{1F335}', '\u{1F337}', '\u{1F338}', '\u{1F339}', '\u{1F33A}',
        '\u{1F33B}', '\u{1F33C}', '\u{1F33D}', '\u{1F33E}', '\u{1F33F}',
        '\u{1F340}', '\u{1F341}', '\u{1F342}', '\u{1F343}', '\u{1F344}',
        '\u{1F30E}', '\u{1F30F}', '\u{1F307}', '\u{1F303}', '\u{1F304}',
        '\u{1F305}', '\u{1F306}', '\u{1F309}', '\u{1F30A}', '\u{1F30B}',
        '\u{1F30C}', '\u{1F30D}', '\u{1F315}', '\u{1F31B}', '\u{1F31C}',
        '\u2601\uFE0F', '\u26C5', '\u26C8\uFE0F', '\u{1F324}', '\u{1F325}',
        '\u{1F326}', '\u{1F327}', '\u{1F328}', '\u{1F329}', '\u{1F32A}',
        '\u{1F32B}', '\u{1F32C}', '\u{1F32D}',
        '\u2602\uFE0F', '\u2614', '\u26A1', '\u2744\uFE0F', '\u2603\uFE0F',
      ]
    },
    {
      name: 'Objects',
      emojis: [
        '\u{1F4A1}', '\u{1F4A1}', '\u{1F4A3}', '\u{1F4A4}', '\u{1F4A5}',
        '\u{1F4A6}', '\u{1F4A7}', '\u{1F4A8}', '\u{1F4A9}', '\u{1F4AA}',
        '\u{1F4AB}', '\u{1F4AC}', '\u{1F4AD}', '\u{1F4AE}', '\u{1F4AF}',
        '\u{1F4B0}', '\u{1F4B1}', '\u{1F4B2}', '\u{1F4B8}', '\u{1F48E}',
        '\u{1F48D}', '\u{1F4F0}', '\u{1F4F1}', '\u{1F4F2}', '\u{1F4F3}',
        '\u{1F4F4}', '\u{1F4F5}', '\u{1F4F6}', '\u{1F4F7}', '\u{1F4F8}',
        '\u{1F4F9}', '\u{1F4FA}', '\u{1F4FB}', '\u{1F4FC}', '\u{1F4FD}',
        '\u{1F4FE}', '\u{1F4FF}', '\u{1F500}', '\u{1F501}', '\u{1F502}',
        '\u{1F503}', '\u{1F504}', '\u{1F505}', '\u{1F506}', '\u{1F507}',
        '\u{1F508}', '\u{1F509}', '\u{1F50A}', '\u{1F50B}', '\u{1F50C}',
        '\u{1F50D}', '\u{1F50E}', '\u{1F50F}', '\u{1F510}', '\u{1F511}',
        '\u{1F512}', '\u{1F513}', '\u{1F514}', '\u{1F515}', '\u{1F516}',
        '\u{1F517}', '\u{1F518}', '\u{1F519}', '\u{1F51A}', '\u{1F51B}',
        '\u{1F51C}', '\u{1F51D}', '\u{1F51E}', '\u{1F51F}', '\u{1F520}',
        '\u{1F527}', '\u{1F528}', '\u{1F529}', '\u{1F52E}', '\u{1F58F}',
        '\u{1F3B5}', '\u{1F3B6}', '\u{1F3B7}', '\u{1F3B8}', '\u{1F3B9}',
        '\u{1F3BA}', '\u{1F3BB}', '\u{1F3BC}', '\u{1F3BD}', '\u{1F3BE}',
        '\u{1F3BF}', '\u{1F3C0}', '\u{1F3C1}', '\u{1F3C2}', '\u{1F3C3}',
        '\u{1F3C4}', '\u{1F3C5}', '\u{1F3C6}', '\u{1F3C7}', '\u{1F3C8}',
        '\u{1F3A8}', '\u{1F3AC}', '\u{1F3AD}', '\u{1F3AE}', '\u{1F3A9}',
        '\u{1F3AA}', '\u{1F3AB}', '\u{1F3AF}', '\u{1F3B0}', '\u{1F3B1}',
        '\u{1F3B2}', '\u{1F3B3}', '\u{1F3B4}', '\u{1F4DC}', '\u{1F4D3}',
        '\u{1F4D6}', '\u{1F4D7}', '\u{1F4D8}', '\u{1F4D9}', '\u{1F4DA}',
        '\u{1F4C3}', '\u{1F4C4}', '\u{1F4C5}', '\u{1F4C6}', '\u{1F4C7}',
        '\u{270F}\uFE0F', '\u{1F4DD}', '\u{1F4CE}', '\u{1F4CF}', '\u{1F4D0}',
        '\u{1F4D1}', '\u{1F4D2}', '\u{1F4D4}', '\u{1F4D5}', '\u{1F5C0}',
        '\u{1F5C1}', '\u{1F6E0}', '\u{1F6E1}', '\u2692\uFE0F', '\u26CF\uFE0F',
        '\u2699\uFE0F}', '\u2696\uFE0F', '\u{1F517}', '\u{1F5DC}', '\u{1F6E2}',
        '\u{1F3E0}', '\u{1F3E1}', '\u{1F3E2}', '\u{26EA}', '\u{1F6D6}',
        '\u{1F3E1}', '\u{1F3E2}', '\u{1F3E3}', '\u{1F3E4}', '\u{1F3E5}',
        '\u{1F3E6}', '\u{1F3E7}', '\u{1F3E8}', '\u{1F6AA}', '\u{1F6CF}',
        '\u{1F6CB}', '\u{1F6CC}', '\u{1F6CD}', '\u{1F6CE}', '\u{1F6D2}',
      ]
    },
    {
      name: 'Tech',
      emojis: [
        '\u{1F4BB}', '\u{1F4BC}', '\u{1F4BD}', '\u{1F4BE}', '\u{1F4BF}',
        '\u{1F4C0}', '\u{1F4C1}', '\u{1F4C2}', '\u{1F4C8}', '\u{1F4C9}',
        '\u{1F4CA}', '\u{1F4CB}', '\u{1F4CC}', '\u{1F4CD}', '\u{1F4E0}',
        '\u{1F4E1}', '\u{1F4E2}', '\u{1F4E3}', '\u{1F4E4}', '\u{1F4E5}',
        '\u{1F4E6}', '\u{1F4E7}', '\u{1F4E8}', '\u{1F4E9}', '\u{1F4EA}',
        '\u{1F4EB}', '\u{1F4EC}', '\u{1F4ED}', '\u{1F4EE}', '\u{1F4EF}',
        '\u{1F4F0}', '\u{1F4F1}', '\u{1F4F2}', '\u2328\uFE0F}', '\u{1F5A5}',
        '\u{1F5A8}', '\u{1F5B1}', '\u{1F5B2}', '\u{1F579}', '\u{1F6E0}',
        '\u{1F6E1}', '\u{1F4F7}', '\u{1F4F8}', '\u{1F4F9}', '\u{1F4FA}',
        '\u{1F4FB}', '\u{1F4FC}', '\u{1F4FD}', '\u{1F4FE}', '\u{1F4FF}',
        '\u{1F500}', '\u{1F501}', '\u{1F502}', '\u{1F503}', '\u{1F504}',
        '\u{1F505}', '\u{1F506}', '\u{1F507}', '\u{1F508}', '\u{1F509}',
        '\u{1F50A}', '\u{1F50B}', '\u{1F50C}', '\u{1F50D}', '\u{1F50E}',
        '\u{1F50F}', '\u{1F510}', '\u{1F511}', '\u{1F512}', '\u{1F513}',
        '\u{1F514}', '\u{1F515}', '\u{1F516}', '\u{1F517}', '\u{1F518}',
        '\u{1F519}', '\u{1F51A}', '\u{1F51B}', '\u{1F51C}', '\u{1F51D}',
        '\u{1F51E}', '\u{1F51F}', '\u{1F520}', '\u{1F521}', '\u{1F522}',
        '\u{1F523}', '\u{1F524}', '\u{1F525}', '\u{1F526}', '\u{1F527}',
        '\u{1F528}', '\u{1F529}', '\u{1F52A}', '\u{1F52B}', '\u{1F52C}',
        '\u{1F52D}', '\u{1F52E}', '\u{1F52F}', '\u{1F530}', '\u{1F531}',
        '\u{1F532}', '\u{1F533}', '\u{1F534}', '\u{1F535}', '\u{1F536}',
        '\u{1F537}', '\u{1F538}', '\u{1F539}', '\u{1F53A}', '\u{1F53B}',
        '\u{1F53C}', '\u{1F53D}', '\u{1F540}', '\u{1F541}', '\u{1F542}',
        '\u{1F543}', '\u{1F544}', '\u{1F545}', '\u{1F546}', '\u{1F547}',
        '\u{1F548}', '\u{1F549}', '\u{1F54A}', '\u{1F54B}', '\u{1F54C}',
        '\u{1F54D}', '\u{1F54E}', '\u{1F550}', '\u{1F551}', '\u{1F552}',
        '\u{1F553}', '\u{1F554}', '\u{1F555}', '\u{1F556}', '\u{1F557}',
        '\u{1F558}', '\u{1F559}', '\u{1F55A}', '\u{1F55B}', '\u{1F55C}',
        '\u{1F55D}', '\u{1F55E}', '\u{1F55F}', '\u{1F560}', '\u{1F561}',
        '\u{1F562}', '\u{1F563}', '\u{1F564}', '\u{1F565}', '\u{1F566}',
        '\u{1F567}', '\u{1F570}', '\u{1F571}', '\u{1F572}', '\u{1F573}',
        '\u{1F574}', '\u{1F575}', '\u{1F576}', '\u{1F577}', '\u{1F578}',
        '\u{1F579}', '\u{1F57A}', '\u{1F585}', '\u{1F586}', '\u{1F587}',
        '\u{1F588}', '\u{1F589}', '\u{1F58A}', '\u{1F58B}', '\u{1F58C}',
        '\u{1F58D}', '\u{1F590}', '\u{1F595}', '\u{1F596}', '\u{1F5A4}',
        '\u{1F5A5}', '\u{1F5A8}', '\u{1F5B1}', '\u{1F5B2}', '\u{1F5BC}',
        '\u{1F5BD}', '\u{1F5BE}', '\u{1F5BF}', '\u{1F5C0}', '\u{1F5C1}',
        '\u{1F5C2}', '\u{1F5C3}', '\u{1F5C4}', '\u{1F5C6}', '\u{1F5C7}',
        '\u{1F5C8}', '\u{1F5C9}', '\u{1F5CA}', '\u{1F5CB}', '\u{1F5CC}',
        '\u{1F5CD}', '\u{1F5CE}', '\u{1F5CF}', '\u{1F5D0}', '\u{1F5D1}',
        '\u{1F5D2}', '\u{1F5D3}', '\u{1F5D4}', '\u{1F5D5}', '\u{1F5D6}',
        '\u{1F5D7}', '\u{1F5D8}', '\u{1F5D9}', '\u{1F5DA}', '\u{1F5DB}',
        '\u{1F5DC}', '\u{1F5DD}', '\u{1F5DE}', '\u{1F5DF}', '\u{1F5E0}',
        '\u{1F5E1}', '\u{1F5E2}', '\u{1F5E3}', '\u{1F5E4}', '\u{1F5E5}',
        '\u{1F5E6}', '\u{1F5E7}', '\u{1F5E8}', '\u{1F5E9}', '\u{1F5EA}',
        '\u{1F5EB}', '\u{1F5EC}', '\u{1F5ED}', '\u{1F5EE}', '\u{1F5EF}',
        '\u{1F5F0}', '\u{1F5F1}', '\u{1F5F2}', '\u{1F5F3}', '\u{1F5F4}',
        '\u{1F5F5}', '\u{1F5F6}', '\u{1F5F7}', '\u{1F5F8}', '\u{1F5F9}',
        '\u{1F5FA}', '\u{1F5FB}', '\u{1F5FC}', '\u{1F5FD}', '\u{1F5FE}',
      ]
    },
    {
      name: 'Animals',
      emojis: [
        '\u{1F98A}', '\u{1F98B}', '\u{1F98C}', '\u{1F98D}', '\u{1F98E}',
        '\u{1F98F}', '\u{1F990}', '\u{1F991}', '\u{1F992}', '\u{1F993}',
        '\u{1F994}', '\u{1F995}', '\u{1F996}', '\u{1F997}', '\u{1F998}',
        '\u{1F999}', '\u{1F99A}', '\u{1F99B}', '\u{1F99C}', '\u{1F99D}',
        '\u{1F99E}', '\u{1F99F}', '\u{1F9A0}', '\u{1F9A1}', '\u{1F9A2}',
        '\u{1F9A3}', '\u{1F9A4}', '\u{1F9A5}', '\u{1F9A6}', '\u{1F9A7}',
        '\u{1F9A8}', '\u{1F9A9}', '\u{1F9AA}', '\u{1F9AB}', '\u{1F9AC}',
        '\u{1F9AD}', '\u{1F9AE}', '\u{1F9AF}', '\u{1F9B0}', '\u{1F9B1}',
        '\u{1F9B2}', '\u{1F9B3}', '\u{1F9B4}', '\u{1F9B5}', '\u{1F9B6}',
        '\u{1F9B7}', '\u{1F9B8}', '\u{1F9B9}', '\u{1F9BA}', '\u{1F9BB}',
        '\u{1F408}', '\u{1F415}', '\u{1F416}', '\u{1F434}', '\u{1F436}',
        '\u{1F43A}', '\u{1F43B}', '\u{1F43C}', '\u{1F981}', '\u{1F985}',
        '\u{1F984}', '\u{1F41D}', '\u{1F41E}', '\u{1F41F}', '\u{1F420}',
        '\u{1F421}', '\u{1F422}', '\u{1F423}', '\u{1F424}', '\u{1F425}',
        '\u{1F426}', '\u{1F427}', '\u{1F428}', '\u{1F429}', '\u{1F42A}',
        '\u{1F42B}', '\u{1F42C}', '\u{1F42D}', '\u{1F42E}', '\u{1F42F}',
        '\u{1F430}', '\u{1F431}', '\u{1F432}', '\u{1F433}', '\u{1F438}',
        '\u{1F439}', '\u{1F43D}', '\u{1F43E}', '\u{1F43F}', '\u{1F440}',
        '\u{1F40F}', '\u{1F410}', '\u{1F411}', '\u{1F412}', '\u{1F413}',
        '\u{1F414}', '\u{1F417}', '\u{1F418}', '\u{1F419}', '\u{1F41A}',
        '\u{1F41B}', '\u{1F41C}', '\u{1F435}', '\u{1F437}',
      ]
    },
    {
      name: 'Food',
      emojis: [
        '\u{1F34E}', '\u{1F34F}', '\u{1F350}', '\u{1F351}', '\u{1F352}',
        '\u{1F353}', '\u{1F354}', '\u{1F355}', '\u{1F356}', '\u{1F357}',
        '\u{1F358}', '\u{1F359}', '\u{1F35A}', '\u{1F35B}', '\u{1F35C}',
        '\u{1F35D}', '\u{1F35E}', '\u{1F35F}', '\u{1F360}', '\u{1F361}',
        '\u{1F362}', '\u{1F363}', '\u{1F364}', '\u{1F365}', '\u{1F366}',
        '\u{1F367}', '\u{1F368}', '\u{1F369}', '\u{1F36A}', '\u{1F36B}',
        '\u{1F36C}', '\u{1F36D}', '\u{1F36E}', '\u{1F36F}', '\u{1F370}',
        '\u{1F371}', '\u{1F372}', '\u{1F373}', '\u{1F374}', '\u{1F375}',
        '\u{1F376}', '\u{1F377}', '\u{1F378}', '\u{1F379}', '\u{1F37A}',
        '\u{1F37B}', '\u{1F37C}', '\u{1F37D}', '\u{1F37E}', '\u{1F37F}',
        '\u{1F380}', '\u{1F381}', '\u{1F382}', '\u2615', '\u{1F37E}',
        '\u{1F964}', '\u{1F965}', '\u{1F966}', '\u{1F967}', '\u{1F968}',
        '\u{1F969}', '\u{1F96A}', '\u{1F96B}', '\u{1F96C}', '\u{1F96D}',
        '\u{1F96E}', '\u{1F96F}', '\u{1F970}', '\u{1F971}', '\u{1F972}',
        '\u{1F973}', '\u{1F974}', '\u{1F975}', '\u{1F976}', '\u{1F977}',
        '\u{1F978}', '\u{1F979}', '\u{1F97A}', '\u{1F97B}', '\u{1F97C}',
        '\u{1F97D}', '\u{1F97E}', '\u{1F97F}', '\u{1F980}', '\u{1F950}',
        '\u{1F951}', '\u{1F952}', '\u{1F953}', '\u{1F954}', '\u{1F955}',
        '\u{1F956}', '\u{1F957}', '\u{1F958}', '\u{1F959}', '\u{1F95A}',
        '\u{1F95B}', '\u{1F95C}', '\u{1F95D}', '\u{1F95E}', '\u{1F95F}',
        '\u{1F960}', '\u{1F961}', '\u{1F962}', '\u{1F963}',
      ]
    },
    {
      name: 'Activity',
      emojis: [
        '\u{1F3C3}', '\u{1F3C4}', '\u{1F3CA}', '\u{1F3CB}', '\u{1F3CC}',
        '\u{1F3CD}', '\u{1F3CE}', '\u{1F3CF}', '\u{1F3D0}', '\u{1F3D1}',
        '\u{1F3D2}', '\u{1F3D3}', '\u{1F3D4}', '\u{1F3D5}', '\u{1F3D6}',
        '\u{1F3D7}', '\u{1F3D8}', '\u{1F3D9}', '\u{1F3DA}', '\u{1F3DB}',
        '\u{1F3DC}', '\u{1F3DD}', '\u{1F3DE}', '\u{1F3DF}', '\u{1F3E0}',
        '\u{1F93A}', '\u{1F93C}', '\u{1F93D}', '\u{1F93E}', '\u{1F939}',
        '\u{1F938}', '\u{26F7}', '\u{26F8}', '\u{26F9}', '\u{1F3C6}',
        '\u{1F3C5}', '\u{1F947}', '\u{1F948}', '\u{1F949}', '\u{1F3C8}',
        '\u{26BD}', '\u{26BE}', '\u{1F94E}', '\u{1F3C0}', '\u{1F3D0}',
        '\u{1F3C9}', '\u{1F3B1}', '\u{265F}', '\u{1F3B2}', '\u{1F3B3}',
        '\u{1F3B4}', '\u{1F3A3}', '\u{1F3BF}', '\u{1F3C2}', '\u{1F3F8}',
        '\u{1F94A}', '\u{1F94B}', '\u{1F94C}', '\u{1F94D}', '\u{1F94F}',
        '\u{1F945}', '\u{1F946}', '\u{1F3F5}', '\u{1F3F9}', '\u{1F3F7}',
        '\u{1FA70}', '\u{1FA71}', '\u{1FA72}', '\u{1FA73}', '\u{1FA74}',
        '\u{1FA75}', '\u{1FA76}', '\u{1FA77}', '\u{1FA78}', '\u{1FA79}',
      ]
    },
  ];

  function open(callback) {
    close();
    onInsert = callback;
    activeCategory = 0;
    activeEmoji = 0;
    overlayEl = createOverlay();

    // Close other overlays
    if (typeof FilePicker !== 'undefined') FilePicker.close();
    if (typeof SlashAutocomplete !== 'undefined') SlashAutocomplete.close();

    document.getElementById('overlay-root').appendChild(overlayEl);

    // Position above input area (same as file picker + slash autocomplete)
    var inputArea = document.querySelector('.input-area');
    if (inputArea) {
      var ir = inputArea.getBoundingClientRect();
      overlayEl.style.position = 'fixed';
      overlayEl.style.left = ir.left + 'px';
      overlayEl.style.top = 'auto';
      overlayEl.style.bottom = (window.innerHeight - ir.top + 6) + 'px';
      overlayEl.style.maxHeight = Math.min(300, Math.max(120, ir.top - 12)) + 'px';
    }

    // Clicks inside the overlay must not bubble to document
    overlayEl.addEventListener('click', function (e) {
      e.stopPropagation();
    });

    // Click outside closes
    docClickBound = function () { close(); };
    // Escape closes
    docEscapeBound = function (e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    };
    setTimeout(function () {
      document.addEventListener('click', docClickBound);
      document.addEventListener('keydown', docEscapeBound);
    }, 0);
  }

  function close() {
    if (docClickBound) { document.removeEventListener('click', docClickBound); docClickBound = null; }
    if (docEscapeBound) { document.removeEventListener('keydown', docEscapeBound); docEscapeBound = null; }
    if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
    overlayEl = null;
  }

  function createOverlay() {
    var dropdown = DOM.createElement('div', {
      className: 'dropdown emoji-picker',
      style: { maxWidth: '260px', display: 'flex', flexDirection: 'column', maxHeight: '340px' }
    });

    // Category tabs — fixed at top
    var tabBar = DOM.createElement('div', {
      style: { display: 'flex', flexShrink: '0', borderBottom: '1px solid var(--border)', padding: '4px 6px', gap: '2px', overflowX: 'auto', whiteSpace: 'nowrap', background: 'var(--surface-2)' }
    });

    for (var c = 0; c < CATEGORIES.length; c++) {
      (function (catIdx) {
        var tab = DOM.createElement('span', {
          style: {
            fontSize: '10px', padding: '2px 10px', borderRadius: '10px',
            cursor: 'pointer', color: catIdx === activeCategory ? 'var(--fg)' : 'var(--fg-3)',
            background: catIdx === activeCategory ? 'var(--surface-3)' : 'transparent'
          }
        }, CATEGORIES[catIdx].name);
        tab.addEventListener('click', function () {
          activeCategory = catIdx;
          activeEmoji = 0;
          renderGrid(dropdown, catIdx);
          updateTabs(dropdown, catIdx);
        });
        tab.setAttribute('data-cat-tab', '');
        tabBar.appendChild(tab);
      })(c);
    }
    dropdown.appendChild(tabBar);

    // Emoji grid
    renderGrid(dropdown, activeCategory);

    // Keyboard navigation
    dropdown.addEventListener('keydown', function (e) {
      var emojis = CATEGORIES[activeCategory].emojis;
      var cols = 6;
      if (e.key === 'ArrowRight') { e.preventDefault(); activeEmoji = Math.min(activeEmoji + 1, emojis.length - 1); highlightEmoji(dropdown); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); activeEmoji = Math.max(activeEmoji - 1, 0); highlightEmoji(dropdown); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); activeEmoji = Math.min(activeEmoji + cols, emojis.length - 1); highlightEmoji(dropdown); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); activeEmoji = Math.max(activeEmoji - cols, 0); highlightEmoji(dropdown); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (onInsert && emojis[activeEmoji]) onInsert(emojis[activeEmoji]);
        close();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        activeCategory = (activeCategory + 1) % CATEGORIES.length;
        activeEmoji = 0;
        renderGrid(dropdown, activeCategory);
        updateTabs(dropdown, activeCategory);
      }
    });
    // Make dropdown focusable for keyboard nav
    dropdown.setAttribute('tabindex', '-1');
    setTimeout(function () { dropdown.focus(); }, 50);

    return dropdown;
  }

  function updateTabs(dropdown, catIdx) {
    var tabs = dropdown.querySelectorAll('[data-cat-tab]');
    for (var t = 0; t < tabs.length; t++) {
      tabs[t].style.color = t === catIdx ? 'var(--fg)' : 'var(--fg-3)';
      tabs[t].style.background = t === catIdx ? 'var(--surface-3)' : 'transparent';
    }
  }

  function highlightEmoji(dropdown) {
    var cells = dropdown.querySelectorAll('.emoji-cell');
    for (var i = 0; i < cells.length; i++) {
      cells[i].classList.toggle('active', i === activeEmoji);
      if (i === activeEmoji) cells[i].scrollIntoView({ block: 'nearest' });
    }
  }

  function renderGrid(dropdown, catIdx) {
    var existing = dropdown.querySelector('.emoji-grid');
    if (existing) dropdown.removeChild(existing);

    var grid = DOM.createElement('div', {
      className: 'emoji-grid',
      style: { overflowY: 'auto', flex: '1' }
    });
    var emojis = CATEGORIES[catIdx].emojis;
    for (var i = 0; i < emojis.length; i++) {
      var span = DOM.createElement('span', {
        className: 'emoji-cell' + (i === activeEmoji ? ' active' : ''),
        'data-emoji': emojis[i]
      }, emojis[i]);
      span.addEventListener('click', (function (emoji) {
        return function () {
          if (onInsert) onInsert(emoji);
          close();
        };
      })(emojis[i]));
      span.addEventListener('mouseenter', (function (idx) {
        return function () { activeEmoji = idx; highlightEmoji(dropdown); };
      })(i));
      grid.appendChild(span);
    }
    dropdown.appendChild(grid);
  }

  return { open: open, close: close };
})();
