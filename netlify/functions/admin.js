const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

exports.handler = async (event) => {
  try {
    const { action } = JSON.parse(event.body || '{}')

    // ------------------------------------------------------------
    // INITIALIZE DRAFT
    // ------------------------------------------------------------
    if (action === 'draft/initialize') {
      const { week_number } = JSON.parse(event.body)

      const { error } = await supabase
        .from('draft_state')
        .upsert({
          week_number,
          status: 'PENDING'
        }, { onConflict: 'week_number' })

      if (error) throw error

      return ok()
    }

    // ------------------------------------------------------------
    // SET STATUS
    // ------------------------------------------------------------
    if (action === 'draft/set-status') {
      const { week_number, status } = JSON.parse(event.body)

      const { error } = await supabase
        .from('draft_state')
        .update({ status })
        .eq('week_number', week_number)

      if (error) throw error

      return ok()
    }

    // ------------------------------------------------------------
    // GENERATE ORDER
    // ------------------------------------------------------------
    if (action === 'draft/generate-order') {
      const { week_number } = JSON.parse(event.body)

      const { data: entries, error } = await supabase
        .from('week_entries')
        .select('id')
        .eq('week_number', week_number)

      if (error) throw error

      const shuffled = entries
        .map(e => e.id)
        .sort(() => Math.random() - 0.5)

      for (let i = 0; i < shuffled.length; i++) {
        await supabase
          .from('week_entries')
          .update({ draft_order: i + 1 })
          .eq('id', shuffled[i])
      }

      return ok()
    }

    // ------------------------------------------------------------
    // RESET SINGLE PICK (FIXED)
    // ------------------------------------------------------------
    if (action === 'draft/reset-pick') {
      const { week_number, user_id } = JSON.parse(event.body)

      const { error } = await supabase
        .from('week_entries')
        .update({
          pga_golfer: null,
          pga_golfer_ext_id: null,
          pro_score: null,
          your_score: null,
          total: null
        })
        .eq('week_number', week_number)
        .eq('user_id', user_id)

      if (error) throw error

      return ok()
    }

    // ------------------------------------------------------------
    // WIPE ALL PICKS FOR WEEK (FIXED)
    // ------------------------------------------------------------
    if (action === 'draft/wipe') {
      const { week_number } = JSON.parse(event.body)

      const { error } = await supabase
        .from('week_entries')
        .update({
          pga_golfer: null,
          pga_golfer_ext_id: null,
          pro_score: null,
          your_score: null,
          total: null
        })
        .eq('week_number', week_number)

      if (error) throw error

      return ok()
    }

    // ------------------------------------------------------------
    // FULL WEEK DELETE (UUID SAFE)
    // ------------------------------------------------------------
    if (action === 'week/wipe') {
      const { week_number } = JSON.parse(event.body)

      // Delete week_entries (UUID safe)
      await supabase
        .from('week_entries')
        .delete()
        .eq('week_number', week_number)

      // Delete week_pro_field
      await supabase
        .from('week_pro_field')
        .delete()
        .eq('week_number', week_number)

      // Delete draft_state
      await supabase
        .from('draft_state')
        .delete()
        .eq('week_number', week_number)

      return ok()
    }

    return error('Unknown action')
  } catch (err) {
    console.error(err)
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    }
  }
}

function ok() {
  return {
    statusCode: 200,
    body: JSON.stringify({ success: true })
  }
}

function error(message) {
  return {
    statusCode: 400,
    body: JSON.stringify({ error: message })
  }
}
