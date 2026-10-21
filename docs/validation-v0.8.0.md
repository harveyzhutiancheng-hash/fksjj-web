# v0.8.0 验证记录

本轮目标是修复可复现的开局指引漏点，接入已核实的鱼肠线和烤鱼配方，补齐海产厨房建设与收藏家交付，并继续核对后续任务。资料边界见 [来源说明](reference-v0.8.md)。

## 工厂与存档

- 领域测试55项通过（经营14、英雄/闯关18、拾荒13、工厂10；执行输出确认，未另存TAP）。新增鱼肠线等级门槛、20鲜鱼扣费、300秒完成、与自动生鱼片竞争原料而不负库存、v1付费快照和既有任务记录迁移检查。
- [本地生产流程](../test-results/v0.8-qa/local-production.json)：9项检查通过。UI实际升级切鱼厂、支付20鲜鱼、离开并刷新、自然等待300.103秒、领取一份鱼肠线、再次刷新。待领产物没有提前进背包，已领取批次没有再次发奖。
- 同一流程检查390×844、320×568、844×390：无横向页面溢出，生产主按钮可命中；小屏详情区可滚动查看原料。
- [缺鱼去向](../test-results/v0.8-qa/local-fish-route.json)：320宽的真实点击从原料不足直接进入钓鱼，工坊关闭，没有误进不产鲜鱼的拾荒场景。
- [多座工厂](../test-results/v0.8-qa/multiple-factories.json)：4项逻辑用例通过，无ID入口优先选择达级切鱼厂；明确选择1级工厂时不偷偷切换，仍正确提示等级限制。这里使用真实open/recipes方法和DOM stub，不冒充浏览器点击。
- [详情稳定性](../test-results/v0.8-qa/detail-stability.json)：同条件A/B重放，旧`innerHTML`与SVG模板串比较会在1.4秒内替换5次详情节点，导致缺料按钮在点击前脱离DOM；缓存实际渲染模板后0次替换，节点稳定，真实缺鱼按钮点击回归通过。[首次失败保留](../test-results/v0.8-qa/fish-route-dom-replacement-failure.json)。
- 工厂新增检查使用上轮实际领域动作获得的营地fixture，再通过queue/tick/claim/collect升级准备。准备阶段的加速tick与正式300秒自然生产分开，见 [fixture来源](../test-results/v0.8-qa/fishline-fixture-provenance.json)。没有向运行中的背包或任务记录注入通关结果。

- [海产厨房完整流程](../test-results/v0.8-qa/local-kitchen.json)：7项检查通过。从已完成旧12目标的领域动作fixture开始，UI按指引建厨房、完成建设、安排烤鱼；实等300.298秒后领取并交付1条烤鱼，准确获得40领袖经验和75金币；刷新后不重发。厨房22木材/10废料费用仍为项目配置，建造目标不编造未知奖励。
- [厨房准备来源](../test-results/v0.8-qa/kitchen-fixture-provenance.json)列出旧目标的所有准备动作及加速900秒，与正式自然5分钟分开。

## 开局指引

修前记录保留于 [before-fresh-results.json](../test-results/v0.8-qa/before-fresh-results.json)、[document事件定位](../test-results/v0.8-qa/dom-before-fresh-results.json)、[390尺寸扩大种子](../test-results/v0.8-qa/390-before-fresh-results.json)。

已确认：320宽seed104的锚点处`elementFromPoint`为canvas，但真实触摸pointerdown/up由Chrome派给邻近`zoom-in`按钮；390宽seed205也有类似事件派给`campaign-button`。另一些样本落到资源栏或扩建控件。它们没有进入canvas事件，因此不能归因为700毫秒点击阈值，也不能靠重试认定已修。Toast计算后的pointer-events为none，已排除本批样本由toast拦截的猜测。

另外补齐后续任务领取指引、后半段建设入口指引；隐藏指引时清掉坐标，避免保留失效目标。

修复为真实UI边界预留24 CSS像素的触摸半径，检查九点canvas归属，且使用同步后的真实hitbox与射线命中结果。开场隐藏HUD仍预留即将显示的范围。没有重试后强行加物资，也没有放宽手势阈值。

- [复现种子修后](../test-results/v0.8-qa/after-final-repro-fresh-results.json)：15局、49次触摸全部成功。
- [扩展种子](../test-results/v0.8-qa/after-final-rounds-fresh-results.json)：45局、152次触摸全部成功。合计60局、201次触摸，无漏点重试或资源注入。尺寸390×844、320×568、844×390。
- [手势回归](../test-results/v0.8-qa/gesture-results.json)：三尺寸共12项，拖动、双指和取消手势不误收集，随后正常触摸可收集。
- [新厨房模型](../test-results/v0.8-qa/seafood-results.json)：三个尺寸实际点击、待领图标与清除、旧厨房共存、销毁后几何和canvas释放均通过。受控模型fixture不冒充完整经营通关或FPS测试。
- [完整定位与边界](../test-results/v0.8-qa/README.md)记录修前A/B及中间失败。v0.7公网历史漏点没有原生事件记录，因此本轮证明的是可复现漏点类型已修，不能倒推那一次的确切原因。

## 交付边界

没有运行前端构建。浏览器尺寸模拟不等于真实手机验收。旧14步、原12项项目后续任务保留，追加2项成为14项后续目标。新增配方与交付成本/奖励有实录依据，但厨房建造费、任务衔接位置、批量队列规则仍属项目配置。上线状态以最终发布回执和HTTPS文件核验为准。

## 最终公网交付

版本`0.8.0`，发布目录`fkssj-0.8.0-20261019T103456Z`，保留0.7旧目录。静态白名单24文件，共2,572,443字节；服务器及HTTPS逐文件大小/SHA256均匹配。HTTP跳转HTTPS，缺失JS返回404，JS的MIME、no-cache和nosniff正常。采用独立DNS映射到47.251.167.53，TLS主机名/证书照常验证。

- [浮层定位对照](../test-results/v0.8-qa/overlay-stability.json)：计算位置时临时隐藏正在定位的浮层，避免它遮住自己的锚点；真实居民需求与钓鱼按钮点击回归通过。居民自身移动仍正常反映在位置上。
- [公网新档](../test-results/public-v0.8-result.json)：6项通过，从空存档跳过开场、按指引触摸收15木、建钓鱼椅、四次收线完成一竿，到刷新恢复；加载的20个源文件SHA与最终源码一致。无失败点击重试。
- [公网加工与交付](../test-results/v0.8-qa/public-production.json)：5项通过。领取烤鱼、交付40经验75金币、领取鱼肠线、新排一份烤鱼、刷新保留批次/成品/14项任务记录。fixture通过付费领域动作推进299秒，来源见[准备记录](../test-results/v0.8-qa/public-production-provenance.json)，不冒充第二次自然5分钟。
- 两个最终公网浏览器报告无页面错误、失败请求或HTTP错误。领域55项的执行结果已确认，未另外保存TAP日志；已有专项报告只覆盖各自检查时间与范围，不扩大为全系统验收。

[发布回执](../deploy/receipt-v0.8.0-2026-10-19.json)。未运行前端构建，未自动提交代码，未完成实体手机验收或全量原版还原。
